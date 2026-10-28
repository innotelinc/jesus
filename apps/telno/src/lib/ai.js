import { config } from '../config.js';
import { getSecret } from './vault.js';

/**
 * The language model, reached through an OpenAI-compatible gateway.
 *
 * One client for everything that needs reasoning: campaign suggestions, grading
 * a transcript, and the operations autopilot that assigns and closes its own
 * tasks. Keeping it here means a single place decides the model, the timeout
 * and what happens when no key is present.
 *
 * The key is never a constant in this file. It comes from the vault
 * (LLM_API_KEY, written from Settings) or from the environment, in that order,
 * so a container that was handed a key at deploy time does not need anyone to
 * paste it again.
 */

const KEY_NAME = 'LLM_API_KEY';

export const aiKey = () =>
  getSecret(KEY_NAME) || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

export const aiConfigured = () => !!(config.ai.enabled && aiKey());

export const aiSource = () =>
  getSecret(KEY_NAME) ? 'vault' : process.env.LLM_API_KEY || process.env.OPENAI_API_KEY ? 'environment' : 'none';

/** What the console shows: enough to know it is wired, never the key itself. */
export const aiStatus = () => {
  let host = '';
  try {
    host = new URL(config.ai.baseUrl).host;
  } catch {
    host = config.ai.baseUrl;
  }
  return {
    enabled: config.ai.enabled,
    configured: aiConfigured(),
    model: config.ai.model,
    host,
    source: aiSource(),
  };
};

class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * One completion. Returns `{ ok, text, error }` rather than throwing, because
 * every caller has a useful fallback: a grader can fall back to rules, a
 * suggestion list can fall back to templates. A missing key must not take a
 * route down.
 */
export async function chat({ messages, model, temperature = 0.2, maxTokens = 800, json = false } = {}) {
  if (!config.ai.enabled) return { ok: false, error: 'ai_disabled' };
  const key = aiKey();
  if (!key) return { ok: false, error: 'ai_not_configured' };

  let res;
  try {
    res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || config.ai.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
    });
  } catch (err) {
    // A timeout is the common failure on a slow gateway, and it is a fallback in
    // every caller — never a 500 for the operator.
    return { ok: false, error: err.name === 'TimeoutError' ? 'ai_timeout' : `ai_network: ${err.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `ai_http_${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
  }

  const body = await res.json().catch(() => null);
  const text = body?.choices?.[0]?.message?.content;
  if (!text) return { ok: false, error: 'ai_empty_response' };
  return { ok: true, text: String(text), model: body?.model || model || config.ai.model };
}

/**
 * A completion that must be an object. Models wrap JSON in fences often enough
 * that unwrapping is part of parsing, not a hack: weakening a whole feature
 * because a model added ```json is the worse trade.
 */
export async function chatJson(options) {
  const result = await chat({ ...options, json: true });
  if (!result.ok) return { ok: false, error: result.error };
  const raw = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const value = JSON.parse(raw);
    return { ok: true, value, model: result.model };
  } catch {
    return { ok: false, error: 'ai_invalid_json' };
  }
}

/** A one-line probe for the Settings screen, so "test" means a real round trip. */
export async function testAi() {
  if (!config.ai.enabled) return { ok: false, error: 'ai_disabled' };
  if (!aiKey()) return { ok: false, error: 'ai_not_configured', host: aiStatus().host };
  const started = Date.now();
  const result = await chat({
    messages: [
      { role: 'system', content: 'You are a connectivity probe. Reply with the single word: ok' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 8,
  });
  return {
    ok: result.ok,
    error: result.error || null,
    model: result.model || config.ai.model,
    latencyMs: Date.now() - started,
    reply: result.ok ? result.text.slice(0, 40) : null,
  };
}
