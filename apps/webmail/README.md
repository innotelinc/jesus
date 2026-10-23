<p align="center">
  <img src="public/branding/Loomix_Logo.svg" alt="Loomix Mail — email, calendars, contacts and files" width="420" />
</p>

# Loomix Mail

**Loomix Mail is the browser client of Loomix: email, calendars, contacts and files on your own infrastructure.** It talks to [Stalwart Mail Server](https://stalw.art/) over JMAP, puts everything behind one sign-in, and adds the administration surface, themes, plugins and PWA install that a real deployment needs.

This repository is the [Innotel](https://innotel.us) fork of [Bulwark Webmail](https://github.com/bulwarkmail/webmail), maintained as the Loomix client. Upstream code remains AGPL-3.0; the Loomix name and artwork are Innotel's.

## What it does

- **Mail** — conversations, labels, rules, vacation, search, offline cache and PWA notifications.
- **Calendar and contacts** — CalDAV/CardDAV through Stalwart, with invitations and shared calendars.
- **Files** — WebDAV file storage in the same session as mail.
- **Identity** — OIDC against Authentik, with a single sign-out and an admin role that maps to the mail server.
- **Administration** — branding, domain mapping, policies, plugins, themes, telemetry controls and the setup wizard.
- **Many hosts, one build** — per-domain branding overrides let `mail.<domain>` serve that tenant's name and logo.

## Quick start (Docker)

```bash
cp deploy/innotel/.env.local.example .env.local
# set SESSION_SECRET, ADMIN_PASSWORD and JMAP_SERVER_URL at minimum
docker compose up -d
```

The image is published as `ghcr.io/innotelinc/webmail`. The `deploy/innotel/` directory holds the production compose file, environment template and the notes for running it behind an NPM edge.

## Configuration

Everything a deployment usually changes is an environment variable, documented in [`.env.example`](.env.example):

| Variable | Meaning |
| --- | --- |
| `APP_NAME` | Name in the tab, login heading, About card and PWA manifest |
| `APP_SHORT_NAME` | Home-screen label |
| `APP_DESCRIPTION` | PWA/OG description |
| `JMAP_SERVER_URL` | Stalwart's JMAP endpoint |
| `FAVICON_URL` | Favicon (defaults to the Loomix mark) |
| `LOGIN_LOGO_LIGHT_URL` / `LOGIN_LOGO_DARK_URL` | Login mark |
| `PWA_THEME_COLOR` | Browser/PWA chrome colour (`#4f46e5`) |
| `OAUTH_*` | OIDC client for Authentik |
| `STALWART_ADMIN_ACCESS` | How the admin UI reaches Stalwart |

Branding assets live in `public/branding/`. The Loomix set is:

- `Loomix_Mark.svg` — app mark (square, works on light and dark)
- `Loomix_Logo.svg` / `Loomix_Logo_White.svg` — wordmark
- `Loomix_Logo_with_Lettering_Dark_Color.svg` / `..._White_and_Color.svg` — wordmark with the mark
- `Loomix_Favicon.svg`, `Loomix_Icon_Color.png`
- `Loomix_OG.png` — 1200×630 share card

Replace those files to white-label the build; no code change is needed.

## Development

```bash
npm ci
npm run dev        # http://localhost:3000, with the mock JMAP server
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions this fork inherits, and [the upstream documentation](https://bulwarkmail.org/docs) for the client's architecture and extension API.

## License and attribution

Loomix Mail is distributed under the **GNU AGPL-3.0**, like the upstream project. The upstream copyright and attribution are kept in [LICENSE](LICENSE) and [NOTICE](NOTICE). If you run a modified build, point `SOURCE_CODE_URL` at your source so users can find it, as AGPL-3.0 §13 requires.

Upstream: [bulwarkmail/webmail](https://github.com/bulwarkmail/webmail) · [bulwarkmail.org](https://bulwarkmail.org) · [Stalwart](https://stalw.art).
