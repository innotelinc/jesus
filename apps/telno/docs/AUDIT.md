# Live audit — existing telephony stack (Chrome :9222)

Captured via the Chrome DevTools Protocol (`Runtime.evaluate` + DOM/CSS domains) on the three
open product tabs. Raw dumps: `reports-zeus.json`, `insp-pbx_it_com_workflow.json`,
`insp-pbx_pbx_it_com_admin.json`. Re-run with `node scripts/cdp-inspect.mjs <url-substring>`.

## What is actually running

| Product | Origin | Title | Engine |
|---|---|---|---|
| Zeus (PBX Ops) | `app.pbx.services/dashboard/operations` | Operations — Zeus | Next.js + Tailwind v4 (lightningcss), Geist font |
| Capstone (Voice AI) | `pbx.it.com/workflow` | Capstone | Next.js + Tailwind (shadcn-style, oklch), v1.49.0 |
| FreePBX | `pbx.pbx.it.com/admin/config.php` | FreePBX Administration | PHP + jQuery, Open Sans, 11 sheets / 4,657 rules |
| AvantFAX | `pbx.pbx.it.com/fax/inbox.php` | - AvantFAX - | PHP, separate auth + session |

Four applications, four logins, three design systems, two runtimes, zero shared API.

## Zeus layout (the good-looking one — keep this visual language)

- Viewport 1280×585 @1.5 DPR, document 2000px tall → single column stack, no breakpoints
  registered in the CSSOM (**0 media queries**; responsive work is all Tailwind utilities).
- Shell: `max-w-7xl` centered, `flex` + `gap-8` + `px-5 py-8 sm:px-8`.
- Sticky header 65px: `sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl`.
- Sidebar 224px (`w-56`, `hidden sm:block`), main `min-w-0 flex-1` = 954px.
- Mobile: `fixed bottom-0 left-0 right-0 z-50` 45px bottom bar — nav duplicated a third way.
- Toasts: `fixed right-4 top-4 z-[100] w-80`.
- Content grids are ad-hoc: `310px 310px 310px`, `219px ×4`, `293.55px ×3`.

**Tokens in use (31):** base `--background: #f8f9fa` / `--foreground: #1a1a2e`, but the shell is
actually dark (`bg-ink-950` → `#07070d`) with light ink tokens — the light/dark token pair is
inverted, so `--color-white` is `#1a1a2e`. This is a live inversion bug: any component reading
`--color-white` gets near-black.

**Palette (frequency-weighted):** text `rgb(244,244,248)`, muted `oklab(1 0 0 / .5)`, `/.4`, `/.25`,
accent `rgb(165,161,255)`, primary `rgb(84,73,250)`, success `rgb(52,211,153)`, surface `rgb(7,7,13)`.

**Type scale in use:** 14px (154×), 16px (129×), 12px (52×), 10px (37×), 11px (19×), 20/18/24px (<5×).
Eight sizes for a dashboard; 10–11px labels are below readable minimum.

**Shape:** 12px (38×) cards, 8px (10×), 16px (6×), plus `2.23696e+07px` (15×) — that's the
`rounded-full` overflow value, which is fine in CSS but a trap in any token pipeline that
rounds or serializes numbers.

**Class vocabulary:** utility soup — 90× `items-*`, 79× `flex`, 67× `font-*`, 54× `gap-3`,
51× `text-sm`, 46× `border`… no component primitives. Every card is re-typed by hand.

## REA re-check — 2026-10-26 (`Today — Zeus`)

Re-inspected over the CDP page domain once REA was connected (`inspect_web_page`, evidence
`ev_078f1303…`, target `60C4D0F3…`); 507 DOM nodes, 499 accessibility nodes, 17 scripts,
1 stylesheet, 2 fonts.

- **Shell regions:** `banner` (logo, menu button, clock, logout) → `complementary` nav →`main`.
  Three landmark regions, no duplicated nav in the DOM tree at this breakpoint (the mobile bar is
  CSS-hidden, not rendered twice).
- **Nav inventory (18 destinations, 7 groups):** dashboard, history, numbers, voice, workflows,
  capstone, voicemail, fax, messages, contacts, billing, settings, estate, health, operations,
  admin — plus 4 external links marked `outside_policy`.
- **Styling:** one 71,476-byte stylesheet for the whole product; no CSSOM media queries beyond it.
- **Storage:** 1.16 MB used, **zero** `localStorage`/`sessionStorage`/IndexedDB keys — session is
  cookie-only, which is why the audit's "auth exists 3×" problem is fixable with one session.
- **A11y:** `sectionheader`/`heading`/`para` roles present, but 0 named buttons in the captured
  tree (labels live in icon-only markup) and a live `polite` region plus an `assertive` alert.

This is the same IA the reconstruction keeps: one shell, one nav, one stylesheet, cookie session.

## A11y / robustness signals

- Zeus: 4 `<button>` for 49 links, **no focus-visible rules anywhere**, no labels on the
  notification stack, three separate nav implementations (aside, mobile bar, header).
- Capstone: 12 landmarks, 23 buttons, healthy semantics — the better-behaved app.
- FreePBX: 2 landmarks, 1 unlabeled input, 10 media breakpoints (575.98–1200), jQuery-era markup.

## Dedupe findings (what "dedupe" should mean here)

1. **Navigation** appears 3× in Zeus alone and again in Capstone (`Voice Agents`, `Telephony`,
   `Billing`, `Reports`, `Recordings`, `Providers`, `Credentials`, `Files`, `Campaigns`).
2. **Auth** exists 3× (Zeus, Capstone, FreePBX/AvantFAX). Nothing shares a session.
3. **Contacts/number registry** exists in at least 3 places (Zeus Contacts, Zeus Phone Numbers,
   FreePBX extensions) with no canonical key. This is where the worldwide phonebook registry
   belongs: one table, E.164 as the key, everything else references it.
4. **Billing** appears in both Zeus and Capstone.
5. **Design tokens** are duplicated per app and already contradict each other (Zeus inverted
   white/black, Capstone oklch, FreePBX legacy hex).

## Conclusion driving the rebuild

The stack is not short of features — it is short of **one identity, one API, one design system**.
A slim control plane (single container, embedded DB, one JSON API) that *speaks to* FreePBX/Zeus
over AMI/ARI instead of replacing them is the lowest-resource path that still unifies everything.
The registry is the same table the platform already needs, exposed publicly.
