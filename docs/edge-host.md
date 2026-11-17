# Where the Cerulean edge actually lives

`192.168.1.71` — hostname `proxy`, the box every public name in this estate is
served from — is an incus container on **i4**. It is not on i1, and it is not
inside the `ontrak` container:

```
i4 · 192.168.1.54          bare metal ("Surface Pro")
└── proxy · 192.168.1.71   incus container: Cerulean — NPM, Authentik, Vault,
    └── 24 Docker containers   Technitium (DNS), the OmniRoute door

i1 · 192.168.1.51          bare metal (HP Slim Desktop 290-p0xxx)
└── ontrak · 192.168.1.21  incus container: the OnTrak family — nothing to do with the edge
```

## 0. Why this page had it wrong until 2026-11-17

The first version of this page said `proxy` was nested inside the `ontrak`
container on i1. It is not, and the mistake is worth keeping because it is easy
to repeat: **`incus` on `.21` is pointed at a remote, not at its own socket.**

- `incus remote list` inside `ontrak` shows `i2 (current) https://192.168.1.52:8443`
  and `local unix://`.
- `incus list local:` inside `ontrak` returns an **empty table** — that
  container's own incus has no instances at all.
- So `incus config show proxy`, run on `.21`, was answering for an instance on
  whichever host that client pointed at. It read like a local nested instance
  and was never one.

What settles it, measured 2026-11-17:

- `proxy`'s `/sys/class/dmi/id/product_name` reads **Surface Pro**; i1's reads
  **HP Slim Desktop 290-p0xxx**. A container sees its own host's DMI, so the two
  are different machines.
- `proxy`'s rootfs is
  `/var/lib/incus/storage-pools/tank/containers/proxy/rootfs` on ext4 over
  `ubuntu--vg-ubuntu--lv` — an i4 pool, not i1's, whose only pool is `incus`.
- `incus config show i4src:proxy` (taken from i1, over the `i4src` TLS remote)
  returns `limits.memory: 5504MiB`, `limits.cpu: "1"`, and `proxy`'s own
  `memory.max` is `5771362304` — 5504 MiB to the byte.

Rule for next time: `incus <cmd> local:` if you mean the box you are standing
on, or `incus remote switch local` first.

## 1. What was measured (2026-11-17, 05:03Z)

| | i4 | `proxy` |
|---|---|---|
| Address | `192.168.1.54` | `192.168.1.71` |
| What | bare metal, "Surface Pro" | incus container, rootfs on pool `tank` |
| `limits.memory` (written on i4) | — | `5504MiB` |
| `memory.max` in the guest | — | `5771362304` (5504 MiB, exact) |
| `memory.current` | — | `4451729408` (4245 MiB) |
| breakdown | — | anon `3370409984`, file `932536320`, kernel `147947520` |
| `limits.cpu` | — | `"1"` |
| kernel | `7.0.0-43-generic` | `7.0.0-43-generic` |
| pressure | — | `memory.events`: `max 24108`, `oom 0`, `oom_kill 0` |

`proxy` runs 24 Docker containers — `cerulean`, Authentik + postgres + redis +
worker, NPM + db + sso, Technitium + sso, vault, the two SSO session stores, both
gateways, the three metrics, omniroute, ntfy and the orion doors — all
`unless-stopped`. `free` inside it reports the cgroup cap, not i4's RAM, so the
cap is the number to read when asking how much the edge has.

The 24108 `max` events are the cap doing its job: memory was reclaimed 24108
times since boot without a single OOM kill. The edge is running close to its
ceiling (4245 of 5504 MiB) but not against it.

### The other box, for contrast

`ontrak` is a container on i1 and has no relationship to the edge. Its numbers,
taken the same morning, are here only so nobody re-derives the old mistake:

| | i1 | `ontrak` |
|---|---|---|
| Address | `192.168.1.51` | `192.168.1.21` |
| What | bare metal, HP Slim Desktop | incus container, the OnTrak family |
| `limits.memory` | — | `2944MiB`, swap `2GiB` |
| `memory.max` in the guest | — | `3087007744` (2944 MiB) |
| `memory.current` | 10085 MiB used of 15279 | `1420726272` (1355 MiB) |

i1 was 10.1 GiB into 15.3 GiB with 5.2 GiB available while `proxy` sat at 4.2 GiB
on another machine entirely.

## 2. What the cap has been

The limit has moved five times, and none of those moves is recorded anywhere but
this page:

| When | `proxy` | `ontrak` (unrelated) | What happened |
|---|---|---|---|
| 2026-10-30, during the outage | 384 → 512 → 768 MiB | 2432 MiB | Raised repeatedly from outside, still far below what the stack needs |
| 2026-10-30, after the outage | 768 MiB → **4 GiB** | 2432 MiB → **5 GiB** | The pass that brought the other containers back |
| 2026-10-31 | **7168 MiB**, `cpu 2` | **2048 MiB** | Moved again from outside |
| 2026-11-02 | 7168 MiB, unchanged | 2048 → **2944 MiB**, swap on | First reading taken on a host rather than inside a guest |
| 2026-11-17 | **5504 MiB**, `cpu 1` | swap `"true"` → `2GiB` | Measured while the estate was being reshaped; see §1 |

So "the 4 GB limit" is history, not the current state: 4 GiB is the floor at
which the stack was proved able to run, 7 GiB was written for a fortnight, and
5504 MiB with 1 vCPU is what is written today. Read §1 rather than trusting any
of those from memory.

## 3. Raising it

Do it on the incus that owns the instance — i4 — not on `.21`, and not inside the
guest:

```sh
# on i4
incus config set proxy limits.memory 6GiB
incus config set proxy limits.cpu 2

# or from i1, over the TLS remote, without logging into i4
incus config set i4src:proxy limits.memory 6GiB
```

`config set` applies live: incus writes the cgroup immediately, so the guest sees
the new `memory.max` without a restart (a restart is still the honest way to
prove the cap survives one). `limits.memory.swap` decides whether the number is
RAM or RAM + swap; on `proxy` it is `false`, which is why the guest reads
`memory.swap.max: 0` and the cap is the whole allowance.

## 4. What a reboot does, and what it does not

- **The caps come back.** They live in the instance config on i4 and are
  re-applied at every start, by host reboot or container restart alike.
- **A change made from inside does not.** `/sys/fs/cgroup/memory.max` is
  read-only in the guest — writing it returns `Permission denied`. Every real
  change is made on i4 (or over the `i4src` remote).
- **The Docker stack comes back by itself**, because all 24 containers are
  `unless-stopped` and Docker starts them after the instance does. There is no
  boot-stack script here as there is on Capstone.
- **`.21` is not part of this.** Restarting `ontrak` does not restart the edge.

## 5. What too little memory looks like

Recorded on 2026-10-30 at 384–768 MiB, so it is recognisable next time rather
than re-diagnosed:

- `cerulean-authentik` exits with `oom=true`; the Rust server wrapper reports
  *"the server has exited unexpectedly"* while the Python child is killed. Its
  worker and the `orion-sso` / `orion-locker-sso` doors fall over with it,
  because they need OIDC discovery to answer.
- **DNS dies with them.** Technitium on this box is authoritative for every
  `telno.*` zone, so the whole estate's names stop resolving — that is the
  symptom people notice, and it is the last link in the chain, not the first.
- `docker ps` cycles: the containers restart, Authentik OOMs again, restart
  counts climb, `memory.events` shows `oom_kill` in the tens, and load runs far
  above the 1 vCPU the box now has.

## 6. The fence question, answered (2026-11-17)

The earlier version of this page left two candidates open: either the edge was
charged to `ontrak` one cgroup deeper, or under a differently-named subtree.
Both were wrong for the same reason — **`ontrak` is not its parent.** The edge is
an instance of i4's incus, and there the accounting is unremarkable:

- i4's config says `limits.memory: 5504MiB`; the guest's `memory.max` reads
  `5771362304`, which is 5504 × 1048576 exactly. Written cap and enforced cap
  agree to the byte, which is the check `scripts/check-container-limits.py` in
  `innotel-platform-stack` exists to make.
- `ontrak`'s cgroup held 1355 MiB while `proxy` held 3214 MiB of anon memory. It
  cannot contain the edge, and now it does not have to: they are on different
  machines.
- Nothing above the edge fences it except i4's own RAM. There is no second number
  to keep in step, and raising `ontrak`'s memory has never had any effect on the
  edge — it was never the constraint.

The residual risk is the ordinary one: `proxy` is at 4245 of 5504 MiB with 24108
`max` reclaim events and no OOM kills, so the cap is what stands between the
17-container public edge and i4's memory. Check it on i4, not on `.21`.

## 7. The checks

```sh
# the written cap, on the incus that owns the instance
ssh root@192.168.1.54 'incus config show proxy | grep -E "limits\.(memory|cpu)"'
# or, from i1, over the TLS remote
incus config show i4src:proxy | grep -E "limits\.(memory|cpu)"

# what the guest actually got, and whether it is under pressure
ssh root@192.168.1.71 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max;
  cat /sys/fs/cgroup/memory.events'

# the stack, not just the container
ssh root@192.168.1.71 'docker ps -q | wc -l'          # 24
curl -s -o /dev/null -w '%{http_code}\n' https://auth.cerulean.innotel.us/   # 302 → login

# and if you are on .21, remember the client is not talking about itself
ssh root@192.168.1.21 'incus remote list; incus list local:'
```

The estate's incus root password is deliberately in no repository (golden rule 4
in `container-placement.md`), so these commands are for whoever holds it.
