# Changelog

All notable changes to Telno. This project follows [semantic versioning](https://semver.org), and
every release is a container tag.

## 1.0.0 — the first release

The first version that is whole enough to run someone's phones: one container, one database, one
console, and the registry underneath it.

**Platform**

- Asterisk 20 and the control API in one image under one supervisor; AMI for the control plane and
  ARI for media, channel control and live recordings.
- Fastify 5 on Node 24, SQLite through `node:sqlite` — no ORM, no Redis, no native modules.
- Schema migrations run in place on boot, so an upgrade keeps its data.
- Health probes across every target the container can observe, append-only, plus a `HEALTHCHECK`.

**Voice**

- Call history (live and completed), extensions with voicemail boxes, carrier trunks, inbound DID
  routing and IVR menus.
- A browser softphone with DTLS-SRTP audio and video, screen sharing, DTMF into IVRs and a popout
  window that stays registered while you work elsewhere.
- coturn support with per-session, expiring TURN credentials for carrier-grade NAT.
- AI voice agents, and workflows with recorded runs.
- Recording policy decided by the grade of service attached to the number, never by the client.

**Messages and documents**

- SMS, MMS and WhatsApp on your numbers.
- Voicemail audio and transcripts; fax in and out, accepting an uploaded attachment or a plain-text
  body.

**Registry and directory**

- One canonical row per E.164 number across 245 countries, with listings that dedupe on normalized
  name and submissions that detect duplicates before review.
- Verification by email or SMS code, an operator moderation queue, owner-only visibility, and an
  opt-out that removes a number from every host, with reversal.
- Six public hostnames served by one registry, each with its own label, tagline and accent.

**Commerce**

- Invoices grouped by currency, Stripe payment links and signature-verified webhooks, one payment
  page for a whole balance.
- An automatic reminder ladder, escalation to a final notice, suspension, and reinstatement on
  payment — every rung written to the ledger before the provider is called, so nothing sends twice.
- Email through Resend or Mailjet, chosen in Settings; provider keys held in an encrypted vault and
  never returned by the API. Each invoice and reminder records the provider that carried it, or the
  reason it failed.

**Estate and devices**

- Sites with a real device inventory — handsets and gateways belong to a site — where devices check
  in with their own token and go stale on their own.
- Provisioning configs a handset can fetch to configure itself.

**Security**

- scrypt passwords, HMAC-signed revocable sessions, `httpOnly` + `sameSite=lax` cookies that are
  `secure` in production, CSP and a permissions policy, peppered and hashed API keys and device
  tokens, and an audit trail.
