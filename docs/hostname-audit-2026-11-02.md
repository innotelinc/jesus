# Estate hostname audit — 2026-11-02

Every A/CNAME record in the 27 authoritative zones that points at an estate address was probed over HTTPS (414 distinct names). Grouped by the address it reaches.

## 45.77.221.158 — 18 names

| result | count | meaning |
|---|---|---|
| ok | 17 | answers with a page |
| auth | 1 | answers, asks for a sign-in (correct) |

## 73.68.203.71 — 144 names

| result | count | meaning |
|---|---|---|
| no-tls | 102 | no usable certificate for this name, or nothing listening on 443 |
| ok | 41 | answers with a page |
| 502 | 1 | certificate fine, upstream behind the edge is down |

<details><summary>names that do not answer</summary>

- `*.genie.innotel.us`
- `*.lab.innotel.us`
- `admin.mail.innotel.us`
- `admin.rizzaura.net`
- `api.atlas.innotel.us`
- `api.rizzaura.net`
- `app.loomix.art`
- `app.loomix.lol`
- `app.rizzaura.net`
- `atheniq.courses`
- `atheniq.institute`
- `atheniq.online`
- `atlas.innotel.us`
- `auth.pbx.it.com`
- `auth.pbx.services`
- `auth.rizzaura.net`
- `chef.atlas.innotel.us`
- `christ.innotel.us`
- `class.atheniq.courses`
- `cm.innotel.tech`
- `cm.innotel.us`
- `com.unity.rizzaura.net`
- `community.rizzaura.net`
- `convex.atlas.innotel.us`
- `coursemate.innotel.tech`
- `denovo.credit`
- `denovocredit.com`
- `directory.pbx.services`
- `directory.pbx.technology`
- `directory.telno.services`
- `genie.ontrak.innotel.us`
- `grafana.capstone.innotel.us`
- `i3.innotel.us`
- `its.ontrak.innotel.us`
- `lab.ontrak.innotel.us`
- `mail.atheniq.courses`
- `mail.atheniq.institute`
- `mail.atheniq.online`
- `mail.innotel.site`
- `mail.innovative.tel`
- `mail.ontrak.technology`
- `mail.pbx.it.com`
- `mail.pbx.services`
- `mail.pbx.technology`
- `mail.rizzaura.net`
- `ns1.atheniq.courses`
- `ns1.atheniq.institute`
- `ns1.atheniq.online`
- `ns1.denovo.credit`
- `ns1.denovocredit.com`
- `ns1.innotel.site`
- `ns1.innotel.tech`
- `ns1.innotel.us`
- `ns1.innovative.tel`
- `ns1.loomix.art`
- `ns1.loomix.lol`
- `ns1.num.directory`
- `ns1.number.directory`
- `ns1.ontrak.technology`
- `ns1.orion.locker`
- `ns1.pbx.it.com`
- `ns1.pbx.services`
- `ns1.pbx.technology`
- `ns1.rizzaura.net`
- `ns1.telno.digital`
- `ns1.telno.directory`
- `ns1.telno.mobi`
- `ns1.telno.network`
- `ns1.telno.online`
- `ns1.telno.services`
- `ns1.telno.tel`
- `ns2.atheniq.courses`
- `ns2.atheniq.institute`
- `ns2.atheniq.online`
- `ns2.denovo.credit`
- `ns2.denovocredit.com`
- `ns2.innotel.site`
- `ns2.innotel.tech`
- `ns2.innotel.us`
- `ns2.innovative.tel`
- `ns2.loomix.art`
- `ns2.loomix.lol`
- `ns2.num.directory`
- `ns2.number.directory`
- `ns2.ontrak.technology`
- `ns2.orion.locker`
- `ns2.pbx.it.com`
- `ns2.pbx.services`
- `ns2.pbx.technology`
- `ns2.rizzaura.net`
- `ns2.telno.digital`
- `ns2.telno.directory`
- `ns2.telno.mobi`
- `ns2.telno.network`
- `ns2.telno.online`
- `ns2.telno.services`
- `ns2.telno.tel`
- `plutus.innotel.us`
- `sentinel.ontrak.innotel.us`
- `sync.ontrak.innotel.us`
- `tix.ontrak.innotel.us`
- `turn.telno.services`
- `v.innotel.us`

</details>

## innotel.site — 1 names

| result | count | meaning |
|---|---|---|
| ok | 1 | answers with a page |

## innotel.tech — 1 names

| result | count | meaning |
|---|---|---|
| ok | 1 | answers with a page |

## innotel.us — 250 names

| result | count | meaning |
|---|---|---|
| no-tls | 168 | no usable certificate for this name, or nothing listening on 443 |
| ok | 78 | answers with a page |
| auth | 2 | answers, asks for a sign-in (correct) |
| 404 | 1 | certificate fine, nothing on that path |
| 502 | 1 | certificate fine, upstream behind the edge is down |

<details><summary>names that do not answer</summary>

- `*.signara.innotel.us`
- `accounts.innotel.us`
- `acme.innotel.us`
- `admin.capstone.innotel.us`
- `admin.cerulean.innotel.us`
- `admin.distro.innotel.us`
- `admin.magnate.innotel.us`
- `admin.monarch.innotel.us`
- `admin.oasis.innotel.us`
- `admin.ontrak.innotel.us`
- `admin.onyx.innotel.us`
- `admin.rizz.innotel.us`
- `admin.zeus.innotel.us`
- `ai.innotel.us`
- `ai.lms.innotel.us`
- `alerts.innotel.us`
- `ansible.innotel.us`
- `api.capstone.innotel.us`
- `api.cerulean.innotel.us`
- `api.oasis.innotel.us`
- `api.onyx.innotel.us`
- `api.rizz.innotel.us`
- `api.zeus.innotel.us`
- `app.capstone.innotel.us`
- `app.cerulean.innotel.us`
- `app.magnate.innotel.us`
- `app.oasis.innotel.us`
- `app.onyx.innotel.us`
- `app.rizz.innotel.us`
- `app.zeus.innotel.us`
- `apps.learn.innotel.us`
- `apps.lms.innotel.us`
- `astpp.innotel.us`
- `atheniq.innotel.us`
- `auth.atheniq.innotel.us`
- `auth.atlas.innotel.us`
- `auth.capstone.innotel.us`
- `auth.cerulean.innotel.us`
- `auth.distro.innotel.us`
- `auth.innotel.us`
- `auth.magnate.innotel.us`
- `auth.monarch.innotel.us`
- `auth.oasis.innotel.us`
- `auth.onyx.innotel.us`
- `auth.plutus.innotel.us`
- `auth.rizz.innotel.us`
- `auth.zapit.innotel.us`
- `auth.zeus.innotel.us`
- `auth1.innotel.us`
- `auto.innotel.us`
- `babyai.innotel.us`
- `backend.api.capstone.innotel.us`
- `backup.onyx.innotel.us`
- `bank.innotel.us`
- `base.innotel.us`
- `bazarr.monarch.innotel.us`
- `bbb.innotel.us`
- `bill.innotel.us`
- `billing.innotel.us`
- `billing.magnate.innotel.us`
- `blueprint.innotel.us`
- `bolt.innotel.us`
- `book.innotel.us`
- `bot.innotel.us`
- `brr.innotel.us`
- `bt.innotel.us`
- `capstone.innotel.us`
- `certs.cerulean.innotel.us`
- `cerulean.cerulean.innotel.us`
- `cerulean.innotel.us`
- `classroom.innotel.us`
- `cloud.innotel.us`
- `code.ai.innotel.us`
- `cola.innotel.us`
- `collab.innotel.us`
- `community.rizz.innotel.us`
- `convex.innotel.us`
- `cool.innotel.us`
- `coturn.zeus.innotel.us`
- `cp.distro.innotel.us`
- `credit.api.innotel.us`
- `credit.innotel.us`
- `dashboard.capstone.innotel.us`
- `db.innotel.us`
- `dc.innotel.us`
- `delivery.innotel.us`
- `demo.innotel.us`
- `dev.innotel.us`
- `discord.innotel.us`
- `distro.innotel.us`
- `dl.innotel.us`
- `dns.proxy.innotel.us`
- `docker.innotel.us`
- `docs.innotel.us`
- `dograh.capstone.innotel.us`
- `droppy.innotel.us`
- `ebook.innotel.us`
- `flow.innotel.us`
- `gpt.innotel.us`
- `grist.capstone.innotel.us`
- `guard.innotel.us`
- `ha.innotel.us`
- `headscale.innotel.us`
- `health.monarch.innotel.us`
- `homarr.innotel.us`
- `hsportainer.innotel.us`
- `httpsms.innotel.us`
- `jupyter.innotel.us`
- `key.innotel.us`
- `langfuse.innotel.us`
- `live.innotel.us`
- `meilisearch.learn.innotel.us`
- `minio.innotel.us`
- `monit.innotel.us`
- `n8n.capstone.innotel.us`
- `n8n.innotel.us`
- `neo4j.innotel.us`
- `neo4js.innotel.us`
- `nix.innotel.us`
- `omni.innotel.us`
- `online.innotel.us`
- `orbi.innotel.us`
- `orbi1.innotel.us`
- `orbi2.innotel.us`
- `payroll.innotel.us`
- `pbx.zeus.innotel.us`
- `pdash.innotel.us`
- `pdm.innotel.us`
- `pfsense.innotel.us`
- `pgp.innotel.us`
- `pi-tailscale.innotel.us`
- `pihole.innotel.us`
- `player.innotel.us`
- `playsms.innotel.us`
- `pm1.innotel.us`
- `pm2.innotel.us`
- `pm4.innotel.us`
- `pmg.innotel.us`
- `portal.capstone.innotel.us`
- `portal.zeus.innotel.us`
- `proxy.api.innotel.us`
- `qb.innotel.us`
- `quad.innotel.us`
- `rankings.rizz.innotel.us`
- `record.innotel.us`
- `repo.innotel.us`
- `repo1.innotel.us`
- `searxng.innotel.us`
- `sec.innotel.us`
- `securedocs.innotel.us`
- `semaphore.ansible.innotel.us`
- `signal.innotel.us`
- `slack.innotel.us`
- `sms.innotel.us`
- `stealth.innotel.us`
- `student.ontrak.innotel.us`
- `stun.innotel.us`
- `subscribe.api.innotel.us`
- `teams.zeus.innotel.us`
- `teleport.innotel.us`
- `test.innotel.us`
- `traefik.innotel.us`
- `tts.innotel.us`
- `tunnel.innotel.us`
- `turn.innotel.us`
- `voip.innotel.us`
- `wazuh.innotel.us`
- `workflow.capstone.innotel.us`
- `ws.zeus.innotel.us`
- `ziso.innotel.us`

</details>

