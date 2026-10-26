# Architecture

## Why this shape

The audited stack (see [AUDIT.md](AUDIT.md)) had four applications, four logins and three design
systems, all pointing at the same phone numbers. Nothing was wrong with the *features* — the cost was
duplication and the lack of a shared key.

Two decisions follow from that:

1. **One number table.** `numbers.e164` is a `UNIQUE` column. Extensions, trunks, call records,
   directory listings and submissions all reference `numbers.id`. This is the dedupe.
2. **The database is the source of truth.** Switch configuration is generated, never hand-edited. A
   corrupt config is one **Apply config** away from correct.

## Processes

| Process | Role | Restart |
|---|---|---|
| Asterisk 20 (`asterisk -f`) | SIP, dialplan, media, voicemail, CDR | supervisor |
| Node 24 (`src/index.js`) | API, registry, directory, static UI | supervisor |
| supervisord | PID 1, reaps children, restarts either process | — |

The API talks to Asterisk over **AMI** only: a plain TCP key/value protocol that costs a few hundred
bytes per connection. There is no second daemon, no bridge process and no need for ARI unless
media-level control is added later.

## Request paths

```
browser ──HTTP──► Node ──► /api/*            JSON (auth: cookie | bearer | x-api-key)
                     └──► everything else    web/dist (SPA fallback to index.html)
switch  ──AMI───►  Node ──► events            channels map → calls table (upsert on Uniqueid)
switch  ──AMI───◄  Node                       Command: pjsip reload / dialplan reload
```

## Data model

```
accounts ── sessions (HMAC token, versioned)

numbers  id · e164 UNIQUE · country · national · line_type · status · visibility
         · trust_score · verified_at · source
   ├── listings    (number_id, name_norm) UNIQUE   ← second dedupe layer
   │     └── listing_search (FTS5, content=external, unicode61)
   ├── submissions  status: awaiting_verification → verified → approved | rejected | duplicate
   ├── extensions   number_id → the DID that rings this device
   └── calls        from_number / to_number (as presented), UNIQUE call_id

optouts   e164 PRIMARY KEY        ← hard suppression, checked on every public path
domains   slug · host UNIQUE · label · accent · scope · enabled
merges    audit of registry merges
events    append-only operator trail (IP hashed, never raw)
```

### Dedupe layers

| Layer | Key | Behavior |
|---|---|---|
| 1. Numbers | normalized E.164 | `+1 (415) 555-0123`, `14155550123`, `0014155550123` all collapse to `+14155550123`. Re-submitting an existing number fills in blanks and returns `deduplicated: true` |
| 2. Listings | `(number_id, normalizeName(name))` | `Acme Ltd` and `ACME Limited` are the same entity; legal suffixes and accents are stripped |
| 3. Submissions | `(e164, name_norm)` | arrives as `status: duplicate` with a link to the existing row, so a reviewer sees provenance |
| 4. Calls | `call_id` (Asterisk Uniqueid) | CDR replays and AMI reconnects upsert instead of appending |
| 5. Design tokens | single stylesheet | the old per-app token copies had already drifted (one inverted `--color-white`) |

### Normalization

`libphonenumber-js` metadata, not a hand-rolled table: 245 countries, trunk prefixes, `(0)` notation,
`00`/`011` international prefixes, extensions (`x42`), and line types (`mobile`, `fixed`, `voip`,
`tollfree`). Numbers that parse but are not structurally possible are rejected; numbers that are
possible but not confirmed valid are stored with `status: reserved` and a lower trust score.

## Public directory

```
GET /api/public/search?q=…&country=…    text → FTS5 · digits → e164 LIKE
GET /api/public/lookup?number=…         normalizes then returns one entry
POST /api/public/submissions            rate limited 5/hour/IP, honeypot
POST /api/public/submissions/:id/verify 6-digit code, hashed, 10 min, 5 attempts
POST /api/public/optout                 always answers the same way
```

Privacy rules, enforced in SQL rather than the client:

- `visibility = 'private'` → excluded from search and lookup.
- `visibility = 'unlisted'` → listed, but the number is masked (`+44 20 •••• 0958`).
- `optouts` → excluded from every public path regardless of visibility.
- Opt-out responses are identical whether or not the number existed, so the form cannot be used to
  probe the registry.
- Verification targets are masked in responses; codes are stored as `sha256(pepper‖submission‖code)`.

## Slimming decisions

| Area | Old | Now | Effect |
|---|---|---|---|
| Rendering | Next.js SSR per app | static build + JSON API | 91 KB gzipped JS, no server render cost |
| Database | separate per app | one SQLite file, WAL | no DB container, ~0 idle RSS |
| Dependencies | Next + UI kit + ORM per app | Fastify + 3 plugins + `node:sqlite` | 0 native modules, ~15 MB prod deps |
| Telephony | FreePBX + Zeus + Capstone | one Asterisk + one AMI client | one config surface, no PHP |
| Auth | 4 logins | one account table, HMAC sessions | single identity |
| Tokens | per-app copies | one stylesheet | drift impossible |

`node:sqlite` (stable in Node 24) is why there is no `better-sqlite3`: no compiler in the image and no
native rebuild on upgrade.

## Security model

- Passwords: `scrypt` (N=16384, r=8, p=1) with per-user salt.
- Sessions: HMAC-SHA256 signed payload `{sub, role, tv, iat, exp}`; `tv` is bumped on logout or
  password change, invalidating every previously issued token.
- Cookies: `httpOnly`, `sameSite=lax`, `secure` in production, 7-day expiry.
- API keys: stored as `sha256(pepper‖key)`, shown once, scoped (`registry:read`, `registry:write`).
  Reads are separated from writes by HTTP method.
- Roles: `owner` (domains, keys, destructive ops), `operator` (telephony + moderation), `viewer`.
- Rate limits: login 10/min, submissions 5/hour, search 60/min, verification 20/10 min.
- Headers: `nosniff`, `DENY` framing, strict referrer policy; CSP in production only (so the Vite dev
  server keeps working).
- Audit trail: every mutating action, with IPs hashed rather than stored.

## Failure behavior

- **AMI down** → API keeps serving; telephony reports `offline` with the last error; config can still
  be generated and written.
- **Switch config invalid** → the previous file is replaced atomically by a full regeneration; a human
  can inspect the exact content in Settings before applying.
- **Verification provider down** → submission is stored, the API reports `delivered: false`, and the
  operator can still see it in the queue.
- **Database** → single writer with `busy_timeout=5000` and WAL; the API fails closed with a 500 rather
  than writing partial rows (all multi-row paths run inside a transaction).

## Extension points

- A new verification provider is one file in `src/lib/channels.js` plus one entry in `CHANNELS`.
- A second switch or a cloud carrier is an `AmiClient` instance plus a provider record in `trunks`.
- A new directory hostname is a row in `domains` — no deploy.
- A new registry consumer gets an API key, not a database credential.
