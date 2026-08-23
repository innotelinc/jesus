# Qdrant Configuration Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain Qdrant configuration and prevent activation until a real embedding-to-Qdrant search verifies the selected model and collection work together.

**Architecture:** The health route remains read-only but exposes collection vector metadata. The card provides a localized mini tutorial and requires a successful search test before activation; that test produces an actual embedding, so it detects mismatched dimensions without guessing a model's size.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, next-intl, Node test runner, Vitest.

---

### Task 1: Read collection metadata in health checks

**Files:**

- Modify: `src/lib/memory/qdrant.ts`
- Modify: `tests/integration/qdrant-routes.test.ts`

- [ ] Add a failing integration test that mocks `/readyz` and `GET /collections/omniroute_memory`, then expects `collection: { exists: true, vectorSize: 2048, vectorName: "omniao" }` from the health route.
- [ ] Run `node --import tsx/esm --test tests/integration/qdrant-routes.test.ts` and observe the expected failure because health lacks collection metadata.
- [ ] Add `getQdrantCollectionMetadata()` to `src/lib/memory/qdrant.ts`. It may only read `GET /collections/<encoded collection>` and returns `{ exists: false }` or `{ exists: true, vectorSize, vectorName }`. It handles unnamed `vectors.size` and named-vector maps; it never returns API keys or changes Qdrant state.
- [ ] Extend `checkQdrantHealth()` to return this metadata after a successful `/readyz` probe.
- [ ] Re-run `node --import tsx/esm --test tests/integration/qdrant-routes.test.ts` and confirm it passes.

### Task 2: Tutorial and search-validation gate

**Files:**

- Modify: `src/app/(dashboard)/dashboard/memory/components/QdrantConfigCard.tsx`
- Modify: `tests/unit/ui/qdrant-config-card.test.tsx`

- [ ] Add failing component tests for a `data-testid="qdrant-setup-tutorial"` trigger, tutorial credit, disabled enable action before validation, and enabled action after a successful `/api/settings/qdrant/search` result.
- [ ] Run `npx vitest run tests/unit/ui/qdrant-config-card.test.tsx` and observe the expected failure.
- [ ] Add `tutorialOpen` and `searchValidated` state. Reset `searchValidated` when configuration is saved or search fails; set it only after `{ ok: true }` from the search endpoint.
- [ ] Disable only the transition that enables Qdrant while `searchValidated` is false; allow disabling normally.
- [ ] Render a compact modal opened from the tutorial trigger. It explains vector-memory retrieval, indirect token savings, HTTPS/API-key protection, matching dimensions, collection creation, and Save → Test connection → Test search. Add credit text through i18n: `Rafa Martins — rafacpti@gmail.com`.
- [ ] Display the health-route collection state: missing collection, unnamed vector size, or named vector plus size.
- [ ] Re-run `npx vitest run tests/unit/ui/qdrant-config-card.test.tsx` and confirm it passes.

### Task 3: Localization and verification

**Files:**

- Modify: `src/i18n/messages/en.json`
- Modify: `src/i18n/messages/pt-BR.json`

- [ ] Add matching English and Portuguese `memory.qdrant` strings for tutorial content, collection states, validation requirement, and credit.
- [ ] Format changed code with `npx prettier --write`.
- [ ] Run `node --import tsx/esm --test tests/integration/qdrant-routes.test.ts`.
- [ ] Run `npx vitest run src/lib/memory/__tests__/qdrant-wiring.test.ts tests/unit/ui/qdrant-config-card.test.tsx`.
- [ ] Run `npm run typecheck:core`.
- [ ] Commit with `feat: guide Qdrant memory configuration`, push `rafacpti23/qdrant-configuration-guidance` to `origin`, and open a draft PR to `diegosouzapw/OmniRoute`.
