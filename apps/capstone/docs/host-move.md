# Moving Capstone off `i4` — destination, sizing, and the runbook

`scripts/backup-capstone.sh` has said since v3.20 that its intended use is
"moving Capstone off this host". This page is the other half of that: **where**
it goes, **how big** it has to be, and the commands that perform the move.

The estate's own records already name the destination. They disagree with the
box, and this page records both sides, because the disagreement is the defect.

## 1. The destination is `i2`

| Source | What it says |
|---|---|
| `innotel-platform-stack/scripts/check-container-addresses.py` (§`EXPECTED`) | `"i2": { "capstone": "192.168.1.30", … }` — the container's address is `.30` and the host that must carry it is **i2** (`root@192.168.1.52`) |
| `innotel-platform-stack/docs/container-placement.md` §*Recommended target map* | i2's row: "`capstone`, `dev`, `www`, `atlas`, `genesis`, `rizzaura` — the heavy, RAM-hungry set". §*Findings* 3: "`capstone` alone is 5.84 GiB of the 8.9". §*Findings* 7: "**`capstone` (5.84 GiB) fits nowhere but i2**" |
| `innotel-platform-stack/docs/container-placement.md` §*The hosts* / §*The i4 host* | i4 belongs `atheniq` `.59`, `mail` `.15`, `vault` `.73`, `vpn` `.43` — the job the 2026-10-09 pass gave it. Capstone is not in that list. i4 is "the weakest of the four hosts: **2 vCPU, ~7.7 GiB, `dir`-backed storage, a 153 G root disk**" |
| `innotel-platform-stack/docs/dev-container-migration.md` (duplicates) | `capstone` → "i2 `capstone` `.30`" |

**i2 is `192.168.1.52`**: 8 vCPU / 13.1 GiB, storage pool `main-pool` (465 GiB
btrfs on `/dev/sdc`), and the host the page already calls "the app host". It is
where every estate record but the box itself puts this container.

Nothing in the network layer has to change, which is what makes this a container
move and not a migration (§6): `.30` is pinned **inside** the guest, so
`capstone.innotel.us`, `app.`/`dograh.`/`workflow.`/`grist.`/`grafana.capstone.innotel.us`
and every NPM proxy host keep forwarding to the same address.

## 2. What the box actually is (measured 2026-10-12)

```
$ hostnamectl | grep -E "hostname|Virtualization"      # capstone / lxc
$ tr '\0' '\n' < /proc/1/environ | grep container=      # container=lxc
$ grep -c ^processor /proc/cpuinfo                      # 2
$ grep -m1 "model name" /proc/cpuinfo                   # Intel(R) Core(TM) i5-7300U
$ cat /sys/fs/cgroup/cpuset.cpus.effective              # 0-1
$ cat /sys/fs/cgroup/memory.max                         # 5905580032  (5.50 GiB)
$ cat /sys/fs/cgroup/memory.current                     # 5.12 GiB (93% of the cap)
$ stat -f -c %T / && df -h / | tail -1
ext2/ext3
/dev/mapper/ubuntu--vg-ubuntu--lv  153G  83G  65G  57% /
```

Every one of those points at **i4**, and none of them at i2:

- **The CPU model is a mini-PC chip.** `lxcfs` masks the *count* in
  `/proc/cpuinfo` to the container's cpuset, but it keeps the host's model
  string. An `i5-7300U` (2 cores / 4 threads) is i4 — "a separate small box".
  i2 is an 8-vCPU guest on pm3; its model is the Proxmox host's, not this.
- **2 vCPU in force, on a host that has 2 vCPU.** i2 has 8. `limits.cpu`
  travels with the rootfs (the placement page says so), so a cap written for
  another host arrives clamped — the estate's `check-container-limits.py` exists
  precisely to report "the written cap is not the fenced one".
- **The root filesystem is i4's.** `/dev/mapper/ubuntu--vg-ubuntu--lv` is a
  plain ext4 LVM root, `153 G` — i4's documented root disk, and exactly what a
  `dir`-pool container shows (its rootfs *is* a directory on the host's root).
  A container on i2 shows **btrfs** (`main-pool`, 465 GiB); on i1/i3 it shows
  zfs. It does not show this.
- **The cap is 5.5 GiB, not the 6 GiB the placement page records** for
  `capstone` — a second drift. Either the cap was trimmed to fit i4 or the
  container was recreated there; both are consistent with §3.

So: **the estate's tables say i2, the container is running on i4.** The
`systemd/capstone.service` copy *on this box* knows it — its comment reads "this
host: i4 has 2 cores and 7.3 GiB total" — which is a host-local note, not a
repository file (the committed `systemd/capstone.service` is a
`WorkingDirectory=/PATH/TO/CAPSTONE` template with no host sizing in it).

## 3. Why that placement is the defect

i4's container set already sums to ~4.4 GiB live (`atheniq` 3.09 GiB on an
8 GiB cap, `vault` 960 MiB, `vpn` 268 MiB, `mail` 102 MiB) on a ~7.2 GiB host,
and the placement page measured **1.0 GiB available** on the state it recorded —
which does not include this container. Capstone's own working set is 5.8–5.9 GiB.
The measured consequences:

- `memory.current` sits at **93%** of the 5.5 GiB cap, with **no swap**.
- `kokoro-fastapi` — the local TTS engine, ~4 GiB to boot — crash-loops:
  `oom` → `die 137` → `start` every 40–90 s (restart count 37 after a recreate,
  past 54 over one session), re-importing torch on two cores each time.
- Load average **82–100 on 2 cores**, and the starvation timed out the ARI
  WebSocket handshake (`TimeoutError: timed out during opening handshake` ×20),
  which is what parked dograh's telephony config at `07:14` and stopped inbound
  calls registering.

None of that is a Capstone bug and none of it is fixable in `docker-compose.yml`:
the stack was sized against the **7.3 GiB** its own unit records and it is being
run in **5.5 GiB** on the estate's smallest host. The fix is the move.

## 4. Pre-flight (on i2, before copying)

```sh
# the remote that reaches i4 — the estate's moves use TLS remotes
# (i1move/i2move/i3move); i4 needs one trusted on i2
incus remote list

# the pool must have room for the rootfs: the copy carries the whole container,
# docker images and all 26 named volumes (7 pbx-* — the six Zeus shares plus
# pbx-portal-data — 12 capstone_*, zeus-portal-data and 6 anonymous) — nothing
# is re-pulled and no volume is migrated separately
incus storage info main-pool
incus list --format csv | head        # what i2 already runs

# and don't mistake a dead neighbour for room: i2's `dev` container (`.74`) is
# expected by the address table but does not answer (see §8)
ping -c1 -W2 192.168.1.74
```

Stop the stack cleanly first — every database in it (Postgres, MariaDB,
Grist, n8n's sqlite, MinIO, Redis) is a named volume, and a consistent copy is
the whole reason to stop rather than copy a live rootfs:

```sh
# on the current host (i4), or from inside the container
systemctl stop capstone.service        # docker compose down, via the unit
```

## 5. The move

```sh
# ── on i2 (192.168.1.52) ─────────────────────────────────────────────────
# 1. pull the whole container off i4: rootfs, docker images, all volumes
incus copy i4move:capstone capstone --storage main-pool

# 2. right-size it for THIS host. The caps travelled with the rootfs, which is
#    how it ended up clamped to 2 CPUs and 5.5 GiB. The stack was sized for a
#    7.3 GiB host (systemd/capstone.service records the host it was measured on
#    as "2 cores and 7.3 GiB total"), so give the container that already —
#    i2 has 8 vCPU / 13.1 GiB and an oversubscribed cap is its normal shape
incus config set capstone limits.memory 7.3GiB
incus config set capstone limits.cpu 4

# 3. start it, then prove the address survived — it is pinned in the guest
#    (/etc/netplan/99-static.yaml: dhcp4: false, addresses: [192.168.1.30/24])
incus start capstone
ssh root@192.168.1.30 'ip -4 -o addr show eth0'
curl -fsS -o /dev/null -w '%{http_code}\n' https://capstone.innotel.us/   # 307 → /auth/login

# 4. only after 3 is green, drop the source
#    on i4:  incus stop capstone && incus delete capstone
```

Two flags worth knowing about, from the estate's own moves
(`incus copy i1move:<name> <name> --storage tank --instance-only`, 2026-10-02):
`--storage main-pool` is what puts the rootfs on i2's pool rather than the
host's default, and `--instance-only` copies the instance **without its
snapshots** — check `incus snapshot list capstone` on i4 first and use it only
if you mean to leave snapshots behind. Then read `incus config show capstone`
back and confirm the `eth0` device is `nictype: bridged` on the bridge i2's own
containers use (`parent: br-lan` on i4).

## 6. After the move — what the address buys, and the checks

Because `.30` is declared inside the guest, these are **unchanged** and only
need verifying, not editing:

| Concern | Why it does not move |
|---|---|
| DNS / NPM proxy hosts | every name resolves to `.30`; the A record names the address, not the host |
| The six public domains | NPM forwards to `.30:3010`/`:8000`/`:14010`–`:14015` regardless of which host answers |
| TURN | the router's forwards and the `edge-turn-relay.sh` shim DNAT to a LAN address, so they keep delivering to `.30` |
| Volumes and their data | 26 named volumes live inside the container's rootfs, so `incus copy` carries them; no `docker volume` round-trip, no dump/restore |
| `PJSIP_MEDIA_ADDRESS`, `DOGRAH_ARI_ENDPOINT`, `SSO_SESSION_REDIS_HOST` | all already correct for `.30` (none of them names a host by its own address) |

Then check the stack, not just the container:

```sh
systemctl status capstone.service                  # the curated 21-service start
docker compose --env-file data/.env.resolved -f docker-compose.yml ps
./scripts/smoke-test.sh                            # the repo's own smoke test
docker exec zeus-freepbx asterisk -rx "ari show apps"          # → dograh_<hex>
curl -fsS -o /dev/null localhost:8881/v1/models && echo tts okay  # shim on :8881
docker inspect kokoro-fastapi --format '{{.RestartCount}}'        # must stay flat
```

The one that matters most is the last two: **kokoro not restarting and the ARI
app registered** are what this move is for.

## 7. Bookkeeping (the tables that already disagree)

1. `innotel-platform-stack/scripts/check-container-addresses.py` — no edit
   needed. Its `EXPECTED` table already names i2, so the move *makes it true*.
   Today it must be failing: `capstone` present on i4 reads as an `unexpected`
   warning there and a `not present` **failure** on i2. Re-run it from the edge
   after the move (`python3 scripts/check-container-addresses.py --hosts …`).
2. `innotel-platform-stack/scripts/check-container-limits.py` — reads each
   container's declared `limits.cpu` against the cpuset actually pinned and
   warns when a cap exceeds the host (the finding i4 carries for `atheniq`'s 3
   on 2). Re-run it on i2 after the move: `4` on an 8-vCPU host is a pass, and
   the run is also the proof the old 2-CPU clamp is gone.
3. `innotel-platform-stack/docs/container-placement.md` — the i2 row states
   `capstone 5.84 GiB (6 GiB)`; the cap becomes **7.3 GiB**, and i4's section
   should note that the container it was never listed under has left.
4. The **on-box** `systemd/capstone.service` comment ("this host: i4 has 2 cores
   and 7.3 GiB total") must be rewritten for i2 (8 cores / 13.1 GiB), or the
   sizing rationale moved somewhere a host move cannot strand it. It is the same
   failure mode the placement page's *Open items* describes for the CPU caps:
   a value set for the host a container *was* on travels with the rootfs.

## 8. Open findings this work surfaced

- **`dev` (`.74`) on i2 does not answer.** The estate's address table expects it
  (`"dev": "192.168.1.74"` under i2, role "the dev container") and
  `docs/container-placement.md` calls it "where the projects run — every
  project's docker stack — and the target of the standalone-project migration".
  It was ping-dead on 2026-10-12 and nothing listened on `:11434` either, which
  is why a stale `OLLAMA_URL=http://192.168.1.74:11434` reached nothing. That is
  a separate defect on the destination host, not a Capstone one.
- **The container's cap is 5.5 GiB where the estate's page records 6 GiB.** The
  page is the record of the 2026-09-27 limits pass; one of the two is stale and
  this page's §2 is the measurement.
- **The move needs host credentials that no repository holds.** `incus` runs on
  i2/i4, not inside this container, and the estate's incus root password is
  deliberately absent from every repo (golden rule 4 in
  `docs/container-placement.md`). The commands in §5 are for whoever holds it.

## 9. Fallback: if i2 cannot take it

i2 is the documented home, but it is also the busiest host by container size and
its `dev` container is already unwell (§8). If the pool has no room, or the
operator would rather not add a 5.9 GiB container to it, the estate's own tool
for moving a *group* between servers is
`innotel-platform-stack/scripts/migrate-stack.py`:

```sh
# old server, stack stopped for a consistent copy
python3 scripts/migrate-stack.py pack 2 --stop --out /tmp/voice-migrate
scp /tmp/voice-migrate/migrate-voice-*.tgz <newhost>:/tmp/
# new server, group's repos checked out beside ips/
python3 scripts/migrate-stack.py restore --in /tmp/migrate-voice-*.tgz
```

That path packs the group's volumes, `.env` files (and the `vault://` secrets
behind them), bind mounts and images and rebuilds the same Docker deployment on a
plain server — it is the right tool when the target is a *new server* rather than
an existing estate container. It does not preserve `.30` the way `incus copy`
does, so a NPM proxy-host repoint would be part of it. i1 (4 vCPU / 14.9 GiB,
8.1 GiB free) is the only estate host with the RAM to be that target in place of
i2; i3 cannot (5.3 GiB total).
