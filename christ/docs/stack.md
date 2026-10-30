# CHRIST in the Innotel Platform Stack

**Role: Integration** — the composition root that turns the estate's products into one
telephone system, and the front door that shows it running.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives there;
this file records only what CHRIST does inside it.

## Boundaries

### Owns

- the estate declaration: the DID, lines, trunk, agents and hours, in one file
- the wiring engine: declaration → the switch's lines, trunk and routing document,
  validated with the switch's own router, applied and read back
- the soul compiler and the agent document the AI plane is populated from
- the capability catalog: a wish → the containers that satisfy it
- the board and the front door, including one-origin access to every product

### Consumes

- `cantus-switch` over `cantus-control` (`/v1/*`) and `cantus-line` (`/ws/line`)
- `cantus-gateway` over `cantus-border`, for the DID and outbound calls
- `telno` as the platform that owns numbers and generates a routing document
- Capstone and dograh over `cantus-ari`, for the agents
- OmniRoute, Soulforge, claude-mem, REA and ontrak-mcp as the AI and tool plane
- Cerulean Vault (deployment secrets, when hosted)
- Cerulean/NPM Edge for DNS, TLS and the public hostname

### Does not own

- the voice plane: no call, no media, no codec, no registration lives here
- the platform's inventory or its database
- the agents, their workflows or their model choice
- identity (Authentik) — where a deployment has a UI it inherits the stack's sign-in
- storage, billing and telephony records (ONYX, Magnate, Telno respectively)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| `christ` | Node.js 24, no dependencies | Board, plan API, souls API, one-origin proxy, wiring CLI |
| `switch` | `cantus-switch` | The voice plane: calls, media, routing, ARI, softphone socket |
| `gateway` | `cantus-gateway` | The SIP border and the carrier trunk |
| `telno` | `telno` | Numbers, routing document, voicemail, CDRs, softphone |
| `console` | `estate/console` | The operator's window on calls and encryption |
| `omniroute` | OmniRoute | One OpenAI-compatible model endpoint |
| Identity | Cerulean Authentik | Sign-in and role claims, where a deployment has a UI |
| Secrets | Cerulean Vault (KV v2) | Production credentials, referenced as `vault://` |
| Trust | Cerulean | DNS, TLS and the public hostname |
| Edge | NPM Edge | The public route in front of the board |

## In the ecosystem

- **The routing document is the contract.** CHRIST writes it; the switch evaluates it.
  Telno can write it too, and whichever ran last is the truth — there is one schema,
  checked by the switch's implementation, not a second copy here.
- **A number is an address, not an account.** Lines are `POST /v1/lines`; a SIP
  credential never reaches this repository.
- **The AI is a route.** An agent is `{ "ari": { "app": "dograh" } }` behind an
  extension, with its prompt compiled from a soul — no second dial plan.
- **Containers follow capabilities.** `catalog.json` is the only place that knows which
  service a wish implies, so a small box can run the voice plane alone.

## See also

- [README](../README.md)
- [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)
- [Cantus interoperability](https://github.com/innotelinc/jesus/blob/main/apps/cantus/docs/interop.md)
