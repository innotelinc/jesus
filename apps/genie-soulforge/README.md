# Soulforge

A local-first editor for AI agent **souls** and their **system prompts**, with a streaming playground for testing the result against a live model.

- **Soul editor** — identity, mission, audience, four voice dials, principles, boundaries, operating rules, response style, capabilities, freeform context, and per-soul temperature / max tokens.
- **Compiled system prompt** — the prompt is generated live from the soul, with per-section toggles, token/word counts, manual editing (with an explicit "detached" state), copy and Markdown export.
- **Playground** — streams replies from an OpenAI-compatible endpoint using the prompt exactly as it stands, including a collapsible "system prompt in effect" panel.
- **Version history** — nameable snapshots stored per soul, with restore and delete. `Ctrl/Cmd + S` takes one from anywhere.
- **Side-by-side diff** — compare any two versions (or a snapshot against the working copy), line by line, with word-level highlighting and a changes-only view.
- **Library** — create, duplicate, confirmed-delete, search, JSON import/export, and Markdown export of a single soul.

Everything is saved to `localStorage` in this browser. There is no account, backend, or telemetry.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

```bash
npm test        # unit tests (prompt compiler, normalization, SSE parser)
npm run build   # typecheck + production build
```

## Model connection

Open the sliders icon in the header and pick a provider:

| Provider | Base URL | Notes |
| --- | --- | --- |
| OmniRoute (default) | `https://gateway.innotel.us/v1` | Innotel's gateway; default model `auto/best-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | Many models, one key |
| OpenAI | `https://api.openai.com/v1` | |
| Custom | any OpenAI-compatible `/v1` | Must allow browser (CORS) requests |

The API key is stored in `localStorage` under `soulforge.settings.v1` and sent only to the configured endpoint. It is never written into the project. Avoid saving a key on a shared machine.

OpenRouter, OpenAI and OmniRoute requests go through the Vite dev proxy (`/llm/...` → provider) so the browser is not blocked by missing CORS headers. The proxy is defined in [vite.config.ts](vite.config.ts) for both `vite dev` and `vite preview`. Custom endpoints are called directly.

## Layout

```
src/
  App.tsx                  app shell, library state, snapshots, import/export
  components/
    Sidebar.tsx            soul library rail
    SoulEditor.tsx         structured soul form
    PromptPane.tsx         compiled prompt, section toggles, manual override
    Playground.tsx         streaming chat
    SettingsDialog.tsx     provider + key + model
    HistoryDialog.tsx      snapshot list and restore
    DiffDialog.tsx         side-by-side prompt comparison
    Markdownish.tsx        safe, limited Markdown rendering (fences, inline code, bold)
  lib/
    soul.ts                soul model, prompt compiler, snapshots, normalization, seeds
    diff.ts                line/word diff and side-by-side alignment
    llm.ts                 provider presets, endpoint mapping, SSE streaming client
    storage.ts             localStorage load/save with validation
  types.ts
tests/
  soul.test.ts
  llm.test.ts
  diff.test.ts
```

### How compilation works

`compilePrompt` builds sections in a fixed order and joins the enabled ones. Empty sections are skipped, so the prompt never contains an empty heading. A manual edit sets `promptOverride`, which wins over the compiler until **Regenerate** clears it. Snapshots store both the rendered prompt and the soul fields, so restoring brings back the exact configuration rather than just the text.

Token counts are estimates (characters ÷ 4, with a word-count floor), not billing numbers.
