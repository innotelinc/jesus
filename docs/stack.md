# JESUS in the Innotel Platform Stack

**Role: the estate** — every Innotel product in one tree, each directory holding
the history it earned.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack and its shared layers lives there; this
file records what the tree is and what it deliberately is not.

## Owns

- the source of every product under [`apps/`](../apps): voice, telephony,
  mail, training, automation tooling, gateways
- one place where the estate's shared contract is declared: `LICENSE`,
  `.env.example`, the attribution guard and this document
- the per-product workflows that build and test each tree separately

## Consumes

- OmniRoute, the OpenAI-compatible gateway every agent product calls
- Cerulean (Authentik identity, DNS, TLS)
- Cerulean Vault (secrets) via `vault://` references
- ONYX for storage, NPM Edge for public hosts

## Explicitly does NOT own

- identity, secrets, DNS/TLS or storage — those belong to the platforms above
- per-product deployment state: each product deploys from its own directory
  and its own workflow, not from the tree's root

## Licensing

The root [LICENSE](../LICENSE) is MIT, so the tree as a whole is unambiguous.
Individual directories may carry their own `LICENSE` where a product has a
different story; that file wins inside its directory, and this document is the
only place that records the arrangement.

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| apps/cantus | Perl | the voice standard |
| apps/telno | Node.js | telephony platform and phonebook |
| apps/webmail | TypeScript | JMAP webmail |
| apps/ontrak | Next.js | training platform |
| christ/ | containers | the products wired into one voice system |

## In the ecosystem

| Flow | Path |
| --- | --- |
| Model calls | product → OmniRoute gateway → provider |
| Identity | Cerulean's Authentik → OIDC → each product's session |
| Secrets | Cerulean Vault → `vault://` refs in each product's `.env` |
