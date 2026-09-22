# Contributing to Bulwark Webmail

Thanks for helping build the webmail we all wished existed. Bug reports, feature requests, translations and patches are all welcome.

The full guide lives in the documentation: **[Contributing](https://bulwarkmail.org/docs/development/contributing)**. It covers the development setup, the test suites, translations and right-to-left layouts, code style, and the pull request process.

The short version:

```bash
git clone https://github.com/bulwarkmail/webmail.git
cd webmail
npm install
cp .env.dev.example .env.local   # built-in mock JMAP server, no mail server needed
npm run dev
```

Before opening a pull request, run `npm run typecheck && npm run lint && npx vitest run`, and use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).

- **Questions**: ask on [Discord](https://discord.gg/tYCujymGrT).
- **Documentation fixes**: the docs are Markdown in the [website repository](https://github.com/bulwarkmail/website/tree/main/docs).
- **Security vulnerabilities**: report them privately to [dev@bulwarkmail.org](mailto:dev@bulwarkmail.org) or through a [security advisory](https://github.com/bulwarkmail/webmail/security/advisories/new), never in a public issue.
