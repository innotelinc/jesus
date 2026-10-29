# Ansible — wire dograh's ARI telephony configuration

This playbook makes dograh's telephony configuration agree with the switch.
There is no FreePBX to configure, no dialplan file to converge, and no
`docker exec … asterisk -rx` step: the switch's routing document is the
dialplan, and dograh only has to be told the ARI endpoint, the credentials and
which inbound extension belongs to which workflow.

```
dograh-ui ──► dograh-api ──ARI(HTTP)──► cantus-switch :8088
                    ▲                        │
                    └──── routing document ──┘   (pbx/cantus/routes.json)
```

## What it does

1. **auth** — logs into the dograh API (signs up on a first run; skipped when
   `DOGRAH_API_TOKEN` is already in `.env`).
2. **api-key** — mints an `X-API-Key` and writes it back to `.env`.
3. **config** — creates or updates the ARI telephony configuration, pointing it
   at the switch (`http://<lan>:8088`, user `dograh`, app `dograh`).
4. **routing** — registers the inbound extension (default `8000`) against the
   interview workflow. The switch's routing document hands `8000@…` to ARI app
   `dograh` — see `pbx/cantus/routes.json`.
5. **verify** — prints the resulting configuration and the phone number.

Every step GETs before it writes, so re-running is safe.

## Run

```sh
ansible-playbook -i ansible/inventory ansible/dograh-ari.yml \
  -e dograh_api_endpoint=http://127.0.0.1:8000 \
  -e dograh_admin_email=ops@capstone.example \
  -e dograh_admin_password='<password>' \
  -e dograh_ari_password='<CANTUS_ARI_PASSWORD from .env>'
```

Values, with env fallbacks, live in `group_vars/all.yml`:

| var | from env | meaning |
| --- | --- | --- |
| `dograh_ari_endpoint` | `DOGRAH_ARI_ENDPOINT`, else `http://$dograh_lan_ip:8088` | the switch's control/ARI port |
| `dograh_lan_ip` | `PJSIP_MEDIA_ADDRESS` | the host LAN address the switch is published on |
| `dograh_ari_app_name` | `DOGRAH_ARI_APP_NAME` | the ARI app the routing document names (`dograh`) |
| `dograh_ari_password` | `DOGRAH_ARI_PASSWORD` | must equal `CANTUS_ARI_PASSWORD` on the switch |
| `dograh_config_name` | `DOGRAH_CONFIG_NAME` | the telephony configuration's title |
| `dograh_inbound_ext` | `DOGRAH_INBOUND_EXT` | the DID/extension handed to this app (`8000`) |

## Verifying by hand

```sh
# the ARI surface is up and the app is registered (Asterisk's ARI root is
# /ari, so applications live beside asterisk/info, not under it)
curl -u dograh:"$CANTUS_ARI_PASSWORD" http://<lan>:8088/ari/applications

# the switch's own view of the same thing
curl -u dograh:"$CANTUS_ARI_PASSWORD" http://<lan>:8088/ari/asterisk/info

# the routing document dograh's DID lands on
curl http://<lan>:8088/v1/routes
```

An inbound call to `8000@<domain>` answers, hands the channel to `dograh`, and
appears in `GET /v1/calls` with `route: agent-dids`.

## Notes

- **Credentials** — dograh's config row holds the ARI password. The switch reads
  `CANTUS_ARI_PASSWORD` (falling back to `DOGRAH_ARI_PASSWORD`) at boot; rotate
  both together.
- **Route keying** — the playbook finds dograh's configuration by `name`
  (`Cantus ARI (dograh)`); renaming it in the UI makes the playbook create a
  second one, so re-run with `-e dograh_config_name=<new name>` instead.
- **No Asterisk** — if a host still has FreePBX/Asterisk containers, this
  playbook neither knows nor cares: nothing it writes mentions them. See
  `pbx/README.md` for the cut-over.
