<p>
  <a href="https://bulwarkmail.org"><img src="https://raw.githubusercontent.com/bulwarkmail/.github/main/profile/banner.png" alt="Bulwark: webmail for Stalwart Mail Server. Mail, calendar, contacts and files in one browser client." width="100%" /></a>
</p>

<p align="center">
  <a href="https://github.com/bulwarkmail/webmail/releases/latest"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/release-dark.svg" /><img src="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/release.svg" alt="latest release" height="24" /></picture></a>&nbsp;
  <a href="https://github.com/bulwarkmail/webmail/pkgs/container/webmail"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/docker-dark.svg" /><img src="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/docker.svg" alt="docker: ghcr.io/bulwarkmail/webmail" height="24" /></picture></a>&nbsp;
  <a href="LICENSE"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/license-dark.svg" /><img src="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/license.svg" alt="license: AGPL v3" height="24" /></picture></a>&nbsp;
  <a href="https://discord.gg/tYCujymGrT"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/discord-dark.svg" /><img src="https://raw.githubusercontent.com/bulwarkmail/.github/main/badges/discord.svg" alt="Discord members online" height="24" /></picture></a>
</p>

<p align="center">
  <a href="https://bulwarkmail.org">Website</a> ·
  <a href="https://bulwarkmail.org/docs">Documentation</a> ·
  <a href="https://demo.bulwarkmail.org">Live demo</a> ·
  <a href="https://github.com/bulwarkmail/webmail/releases">Releases</a> ·
  <a href="https://discord.gg/tYCujymGrT">Discord</a>
</p>

Bulwark Webmail is a self-hosted webmail client for [Stalwart Mail Server](https://stalw.art/), built with Next.js on the JMAP protocol. Mail, calendar, contacts and files share one login, one settings store and one admin dashboard.

## Contents

- [Screenshots](#screenshots)
- [Features](#features)
- [Quick start](#quick-start)
- [Other ways to install](#other-ways-to-install)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Development](#development)
- [Community and support](#community-and-support)
- [License](#license)

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/mail-dark.png" />
  <img src="screenshots/mail-white.png" alt="Mail view" width="100%" />
</picture>

<table>
<tr>
<td width="50%"><img src="screenshots/calendar.png" alt="Calendar" /></td>
<td width="50%"><img src="screenshots/contacts.png" alt="Contacts" /></td>
</tr>
<tr>
<td><sub><b>Calendar</b> – month, week, day, and agenda views with drag-to-reschedule, iMIP invitations, and CalDAV subscriptions.</sub></td>
<td><sub><b>Contacts</b> – multiple address books, groups, vCard import/export, and autocomplete in the composer.</sub></td>
</tr>
<tr>
<td><img src="screenshots/theme.png" alt="Themes" /></td>
<td><img src="screenshots/plugins.png" alt="Plugins" /></td>
</tr>
<tr>
<td><sub><b>Themes</b> – bundled color themes or upload your own as ZIP bundles; admins can enforce presets.</sub></td>
<td><sub><b>Plugins</b> – extend the client with bundled or third-party plugins installed from a .zip file.</sub></td>
</tr>
<tr>
<td><img src="screenshots/mail-white.png" alt="Light mode" /></td>
<td><img src="screenshots/settings.png" alt="Settings" /></td>
</tr>
<tr>
<td><sub><b>Light mode</b> – full theme support, remapping HTML email colors by luminance so dark-on-dark text stays readable.</sub></td>
<td><sub><b>Settings</b> – appearance, identities, filters, templates, security, and more.</sub></td>
</tr>
</table>

## Features

- **[Mail](https://bulwarkmail.org/docs/features/email)** – threading, unified inbox, cross-account views, [full-text search](https://bulwarkmail.org/docs/features/email/search), Sieve filters, [S/MIME](https://bulwarkmail.org/docs/guides/smime), templates, scheduled send
- **[Calendar](https://bulwarkmail.org/docs/features/calendar)** – month/week/day/agenda, recurring events, iMIP invitations, CalDAV subscriptions
- **[Contacts](https://bulwarkmail.org/docs/features/contacts)** – multiple address books, groups, vCard import/export
- **[Files](https://bulwarkmail.org/docs/features/files)** – Stalwart's JMAP FileNode storage with previews, sharing and folder upload

Across all four: [single sign-on](https://bulwarkmail.org/docs/getting-started/configuration/authentication) and [2FA](https://bulwarkmail.org/docs/guides/account-security), [multiple accounts](https://bulwarkmail.org/docs/guides/multi-account), 27 languages, [PWA install and web push](https://bulwarkmail.org/docs/features/pwa), [themes](https://bulwarkmail.org/docs/guides/customization), [plugins](https://bulwarkmail.org/docs/guides/plugins) and [keyboard shortcuts](https://bulwarkmail.org/docs/guides/keyboard-shortcuts).

The complete list is on **[All features](https://bulwarkmail.org/docs/features/overview)**.

Bulwark comes in two [editions](https://bulwarkmail.org/docs/getting-started/editions): the full edition, a Node.js server with the admin dashboard, OAuth, plugins and settings sync; and **[Bulwark Lite](https://bulwarkmail.org/docs/getting-started/lite)**, the same client as static files that any web host, or Stalwart itself, can serve.

## Quick start

```bash
docker run -d -p 3000:3000 ghcr.io/bulwarkmail/webmail:latest
```

Open `http://localhost:3000` and the setup wizard walks you through connecting your Stalwart server. The [installation guide](https://bulwarkmail.org/docs/getting-started/installation) covers the details, and [Stalwart setup](https://bulwarkmail.org/docs/getting-started/configuration/stalwart-setup) covers the mail server side.

## Other ways to install

| Method | Guide |
| --- | --- |
| Docker Compose | [Compose](https://bulwarkmail.org/docs/deployment/docker/compose) |
| Behind a reverse proxy or on a sub-path | [Reverse proxy](https://bulwarkmail.org/docs/deployment/docker/reverse-proxy) |
| From source, without Docker | [Manual install](https://bulwarkmail.org/docs/deployment/manual) |
| Lite on any static host | [Static hosting](https://bulwarkmail.org/docs/deployment/static) |
| Lite as a container | [Container image](https://bulwarkmail.org/docs/deployment/static#container-image) |
| Lite served by Stalwart | [Install on Stalwart](https://bulwarkmail.org/docs/deployment/stalwart-app) |

To move to a new version, see [Updating](https://bulwarkmail.org/docs/deployment/updating).

## Configuration

Most installs are configured in the setup wizard on first launch and then in the [admin dashboard](https://bulwarkmail.org/docs/guides/admin). Environment variables work too and suit immutable infrastructure better; a variable always wins over the admin-managed value.

```env
JMAP_SERVER_URL=https://mail.example.com
APP_NAME=My Webmail
```

| Topic | Guide |
| --- | --- |
| Overview, config files and precedence | [Configuration](https://bulwarkmail.org/docs/getting-started/configuration) |
| Every variable | [Environment reference](https://bulwarkmail.org/docs/getting-started/configuration/environment-reference) |
| OAuth2 / OIDC and single sign-on | [Authentication](https://bulwarkmail.org/docs/getting-started/configuration/authentication), [Embedded SSO](https://bulwarkmail.org/docs/guides/embedded-sso) |
| Several JMAP servers, custom endpoints | [Multi-server deployments](https://bulwarkmail.org/docs/getting-started/configuration/stalwart-setup#multi-server-deployments), [Custom endpoints](https://bulwarkmail.org/docs/getting-started/configuration#custom-jmap-server-endpoints) |
| Branding, logos, per-domain branding | [Customization](https://bulwarkmail.org/docs/guides/customization) |
| Anonymous telemetry (off by default) | [Anonymous usage stats](https://bulwarkmail.org/docs/features/telemetry) |

## Documentation

Everything lives at **[bulwarkmail.org/docs](https://bulwarkmail.org/docs)**:

- **Getting started** – [Introduction](https://bulwarkmail.org/docs/getting-started/introduction), [Installation](https://bulwarkmail.org/docs/getting-started/installation), [Editions](https://bulwarkmail.org/docs/getting-started/editions), [Bulwark Lite](https://bulwarkmail.org/docs/getting-started/lite), [Demo mode](https://bulwarkmail.org/docs/getting-started/demo-mode)
- **Deployment** – [Docker](https://bulwarkmail.org/docs/deployment/docker), [Manual install](https://bulwarkmail.org/docs/deployment/manual), [Static hosting](https://bulwarkmail.org/docs/deployment/static), [Install on Stalwart](https://bulwarkmail.org/docs/deployment/stalwart-app), [Updating](https://bulwarkmail.org/docs/deployment/updating)
- **Guides** – [Admin dashboard](https://bulwarkmail.org/docs/guides/admin), [Account security](https://bulwarkmail.org/docs/guides/account-security), [Impersonation](https://bulwarkmail.org/docs/guides/impersonation), [Plugins](https://bulwarkmail.org/docs/guides/plugins), [Marketplace](https://bulwarkmail.org/docs/guides/marketplace), [Troubleshooting](https://bulwarkmail.org/docs/guides/troubleshooting)
- **Extensions** – [Introduction](https://bulwarkmail.org/docs/extensions/introduction), [manifest.json](https://bulwarkmail.org/docs/extensions/manifest), [Publishing](https://bulwarkmail.org/docs/extensions/publishing)
- **Development** – [Architecture](https://bulwarkmail.org/docs/development/architecture), [Contributing](https://bulwarkmail.org/docs/development/contributing)
- **Legal** – [Privacy](https://bulwarkmail.org/docs/legal/privacy)

The pages are Markdown in the [website repository](https://github.com/bulwarkmail/website/tree/main/docs); corrections are welcome there.

## Development

```bash
git clone https://github.com/bulwarkmail/webmail.git
cd webmail
npm install
cp .env.dev.example .env.local   # built-in mock JMAP server, no mail server needed
npm run dev
```

```bash
npm run typecheck
npm run lint
npx vitest run             # unit tests
npm run test:integration   # Stalwart in Docker + Playwright
```

The [contributing guide](https://bulwarkmail.org/docs/development/contributing) covers tests, translations, code style and pull requests; [Architecture](https://bulwarkmail.org/docs/development/architecture) explains how the code fits together.

Built with [Next.js 16](https://nextjs.org/) and React 19, TypeScript, [Tailwind CSS v4](https://tailwindcss.com/), [Zustand](https://zustand-demo.pmnd.rs/), [Tiptap](https://tiptap.dev/), [next-intl](https://next-intl-docs.vercel.app/), [Tabler Icons](https://tabler.io/icons), and a custom JMAP client (RFC 8620). Tests run on [Vitest](https://vitest.dev/) and [Playwright](https://playwright.dev/).

## Community and support

- **Questions and help** – [Discord](https://discord.gg/tYCujymGrT), or [Troubleshooting](https://bulwarkmail.org/docs/guides/troubleshooting) first
- **Bugs and feature requests** – [GitHub issues](https://github.com/bulwarkmail/webmail/issues)
- **Security vulnerabilities** – privately to [dev@bulwarkmail.org](mailto:dev@bulwarkmail.org) or through a [security advisory](https://github.com/bulwarkmail/webmail/security/advisories/new), never in a public issue
- **Release notes** – [CHANGELOG.md](CHANGELOG.md) and [GitHub releases](https://github.com/bulwarkmail/webmail/releases)

## License

[GNU AGPL v3](LICENSE). This repository preserves the original MIT attribution for the fork lineage in [NOTICE](NOTICE).

## Acknowledgments

Thanks to [root-fr/jmap-webmail](https://github.com/root-fr/jmap-webmail/) and [@ma2t](https://github.com/ma2t) for the groundwork this project builds upon.
