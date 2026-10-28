<div align="center">

# JESUS

[![Organisation](https://img.shields.io/badge/org-innotelinc-18181b)](https://github.com/innotelinc)
[![Projects](https://img.shields.io/badge/projects-13-2ea043)](#what-is-in-here)
[![History](https://img.shields.io/badge/history-per%20project%2C%20not%20squashed-4fe3c1)](#history)
[![License](https://img.shields.io/badge/license-per%20project-f5b95b)](#licenses)

**Everything Innotel builds, in one tree.**

One repository for the voice standard, the telephony platform, the mail client, the training
platform, the agent tooling and the gateways — each product in its own directory, each with the
commit history it earned.

</div>

---

## What is in here

Thirteen projects under [`apps/`](apps), one directory each:

| Directory | Project | What it is | Primary language |
| --- | --- | --- | --- |
| [apps/cantus](apps/cantus) | [Cantus](https://github.com/innotelinc/cantus) | A realtime voice standard on one socket — no SIP, no SDP, no RTP, no port range — plus a specification and a dependency-free reference stack that survives symmetric NAT. | Perl |
| [apps/telno](apps/telno) | [Telno](https://github.com/innotelinc/telno) | Self-hosted telephony platform and worldwide phonebook registry: extensions, trunks, IVR, voicemail, fax, SMS, AI voice agents, an encrypted WebRTC softphone, billing and a device estate, in one container. | JavaScript / Node |
| [apps/webmail](apps/webmail) | [Webmail](https://github.com/innotelinc/webmail) | Self-hosted JMAP webmail for Stalwart Mail Server: mail, calendar, contacts and files in one client. | TypeScript |
| [apps/ontrak](apps/ontrak) | [OnTrak](https://github.com/innotelinc/OnTrak) | IT support training platform with gradable Linux, Windows and Office simulations. Carries **[ontrak-genie](apps/ontrak/ontrak-genie)** and **[ontrak-sync](apps/ontrak/ontrak-sync)** alongside the portal, lab, tix and sentinel apps. | TypeScript / Next.js |
| [apps/capstone](apps/capstone) | [Capstone](https://github.com/innotelinc/capstone) | Self-hosted Voice AI Agent platform: AI phone agents over Asterisk/FreePBX with local speech and local LLM — no per-minute fees, no cloud APIs. | Python |
| [apps/omniroute](apps/omniroute) | [OmniRoute](https://github.com/innotelinc/omniroute) | Mirror of [`diegosouzapw/OmniRoute`](https://github.com/diegosouzapw/OmniRoute), vendored for the estate gateway's resilience. | TypeScript |
| [apps/ontrak-mcp](apps/ontrak-mcp) | [ontrak-mcp](https://github.com/innotelinc/ontrak-mcp) | Dependency-free Model Context Protocol client, tool bridge and reference server for agent consoles. | TypeScript |
| [apps/genie-soulforge](apps/genie-soulforge) | [Soulforge](https://github.com/innotelinc/genie-soulforge) | Local-first studio for authoring, compiling and comparing AI agent system prompts, with a streaming playground. | TypeScript |
| [apps/opensms-android](apps/opensms-android) | [OpenSMS](https://github.com/innotelinc/OpenSMS-Android) | Turns an Android phone into a local SMS API server — no monthly gateway, no third party, no account. | Python (Kivy) |
| [apps/rea](apps/rea) | [REA](https://github.com/innotelinc/rea) | Fork of [`morluto/rea`](https://github.com/morluto/rea) with Innotel deployment notes: Ghidra and MCP registration for OnTrak Genie. | TypeScript |
| [apps/dograh](apps/dograh) | [Dograh](https://github.com/innotelinc/dograh) | Open-source voice agent platform. | Python / TypeScript |
| [apps/freebuff](apps/freebuff) | [Onyx](https://github.com/innotelinc/freebuff) | The terminal coding agent that runs on your own gateway: any model, any provider, no account, no telemetry. | TypeScript |
| [apps/claude-mem](apps/claude-mem) | [claude-mem](https://github.com/thedotmack/claude-mem) | Upstream project: persistent context across agent sessions — captures what an agent did, compresses it, injects it into future sessions. Vendored unmodified. | TypeScript / Python |

## History

Every project was imported with `git fast-export` piped through a path rewrite into
`git fast-import`, so its commits live in this tree as commits, not as one squashed "import" each:

| Project | Commits imported |
| --- | --- |
| cantus | 5 |
| telno | 44 |
| webmail | 2803 |
| ontrak | 549 |
| capstone | 355 |
| omniroute | 4633 |
| ontrak-mcp | 7 |
| genie-soulforge | 8 |
| opensms-android | 34 |
| rea | 6015 |
| dograh | 954 |
| freebuff | 9448 |
| claude-mem | 3729 |

Concretely, that means:

- `git log -- apps/cantus` walks Cantus's own history, and `git blame apps/cantus/lib/Cantus/Pump.pm`
  blames the commit that wrote each line, not the import.
- `git log -S'pump(0)' -- apps/cantus` finds the change that introduced a string, across the
  project's whole past.
- Original author, author date, committer date and message are preserved verbatim.
- Commit **hashes differ** from the standalone repositories, necessarily: a commit's hash covers
  the tree, and the tree has moved one directory down. The standalone repos are still there and
  still authoritative for their own history.
- Tags were not imported, so one project's `v1.0` cannot collide with another's.
- **Six paths were renamed, all in `freebuff`.** Its history names session directories like
  `.agents/sessions/03-03-09:09-add-console-log/`, and NTFS cannot hold a `:`. Those characters
  were mapped to `-` on import so the tree checks out on Windows. Every other path is untouched.

### Integrity

Each directory was compared against its source repository's HEAD after import: same file list,
same blob hashes, for all 29,828 files (the six renamed `freebuff` paths aside). Commit counts
match the sources exactly, project by project. Nothing was dropped, filtered or squashed.

## Working in the tree

Each directory is a complete, self-contained project: its own README, build files, container
configuration, tests and licence. There is deliberately **no root build, task runner or shared
dependency manifest** — the stacks are Perl, Node, Python, Android/Kivy and Docker Compose, and a
single command that pretended to build all of them would only mislead. Build instructions are in
the README of the project you are touching.

The root owns the ignore file and the submodule list, because scratch directories, OS noise and
submodules are properties of the whole tree rather than of any one project.

### Submodules

Three projects track git submodules — `dograh` (pipecat), `rea` (its `third_party` tools) and
`freebuff` (OmniRoute) — seven gitlinks in total. Git only reads `.gitmodules` from the repository
root, so those entries were mirrored there as well; the projects keep their own `.gitmodules`
files untouched. Fetch them with:

```sh
git submodule update --init --recursive
```

### Size

The packed history is about **2.8 GB**. That is not the code: `claude-mem` alone carries 714 MB of
session PDFs, `omniroute` is a 499 MB mirror and `freebuff` is 142 MB. If you only want the code
as it stands, clone shallow (`--depth 1`); if you want a project's past, clone fully and be
patient once.

## CI

GitHub only runs workflows from the **root** `.github/workflows`, so each app's test workflow has a
copy there, and only that copy runs. Every one is path-filtered: a push that touches one app starts
one app's pipeline, not thirteen.

| App | Root workflows |
|---|---|
| cantus | `cantus-ci.yml` |
| capstone | `capstone-ci.yml` |
| claude-mem | `claude-mem-ci.yml`, `claude-mem-ods-native.yml`, `claude-mem-windows.yml` |
| dograh | `dograh-api-tests.yml`, `dograh-pre-pr-drift-check.yml` |
| freebuff | `freebuff-ci.yml` |
| genie-soulforge | `genie-soulforge-ci.yml` |
| omniroute | `omniroute-ci.yml` |
| ontrak | `ontrak-ci.yml` |
| ontrak-mcp | `ontrak-mcp-ci.yml` |
| opensms-android | `opensms-android-ci.yml` |
| rea | `rea-ci.yml` plus the fourteen `rea-*.yml` reusable workflows it calls |
| telno | `telno-ci.yml` |
| webmail | `webmail-ci.yml`, `webmail-tests.yml`, `webmail-perf-guard.yml` |

The originals stay in `apps/<app>/.github/workflows` as the source of truth. The root copies are
**generated** from them by [tools/port-workflows.pl](tools/port-workflows.pl), which handles the
only things the extra directory level changes: the `on:` path filters, a job-wide
`working-directory: apps/<app>`, `./` references to each app's local actions and reusable
workflows, `github.workspace`, `hashFiles()` globs, and per-app concurrency groups.

```sh
perl tools/port-workflows.pl          # rewrite the root copies
perl tools/port-workflows.pl --check  # exit 1 if they are stale
```

Edit the file under `apps/` and regenerate; a hand edit to a root copy is overwritten, and each one
says so in its first comment.

Two composite actions needed a hand change, because an action's own steps always run at the
workspace root: `omniroute`'s `npm-ci-retry` and `rea`'s `portable-build-cache` now resolve their
project root from `${{ github.action_path }}`. That works at either depth, so it is correct in the
standalone repositories too — but it lives in the app's file, so a re-import of either project
drops it. `tools/port-workflows.pl` looks for the marker comment and warns if the patch is gone.

**Release, publish, deploy, and Pages workflows are deliberately not ported.** In a monorepo a push
to `main` would publish thirteen artefacts, thirteen images and thirteen Pages sites instead of one,
and several of them target per-repository state that does not exist here. They remain in
`apps/<app>/.github/workflows` to document each project's release process; releases still run from
the standalone repositories.

## Updating a project from its standalone repository

The standalone repositories are still the upstreams; nothing was archived or deleted. Develop in
the product's own repository — this tree is an index of the estate, not a replacement for each
product's home — and re-import when you want the snapshot refreshed:

```sh
git clone https://github.com/innotelinc/cantus.git /tmp/cantus
git -C /tmp/cantus fast-export --all \
  | perl tools/prefix.pl apps/cantus cantus \
  | git fast-import --quiet --force
git merge --allow-unrelated-histories import/cantus -m "Re-import cantus"
```

The rewrite is deterministic, so a project that has not moved re-imports to an identical tree and
the merge is trivial. A project that *has* moved brings genuinely new commits, and those merge as
new work: rewritten hashes mean there is no fast-forward path by construction, which is the price
of real per-project history inside one repository rather than one squashed commit per project.

## Licenses

Each project keeps its own `LICENSE` file and its own terms apply to it: Cantus is MIT, OpenSMS
and claude-mem are Apache-2.0, and the mirrors (`omniroute`, `rea`, `dograh`, `freebuff`) keep the
licences they were forked under. Read the licence in the directory you are using rather than
assuming one for the tree.
