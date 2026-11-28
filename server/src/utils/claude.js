// One shared Claude client for SimonStays features, and a create() that opts
// into the server-side refusal fallback (falling back to a plain request on
// accounts without that beta). Dormant-safe: null client without ANTHROPIC_API_KEY.
let Anthropic = null;
try { const pkg = require('@anthropic-ai/sdk'); Anthropic = pkg && (pkg.default || pkg); } catch (e) { /* SDK not installed */ }

const MODEL = process.env.SIMONSTAYS_AI_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (client) return client;
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic();
  return client;
}
const enabled = () => !!getClient();

async function create(params) {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (Anthropic && e instanceof Anthropic.BadRequestError) return c.messages.create(params);
    throw e;
  }
}

// The JSON a structured-output response carries, or null (refusal, cut off, malformed).
function jsonOf(resp) {
  if (!resp || resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') return null;
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch (e) { return null; }
}

// For tests.
function setClient(c) { client = c; }

module.exports = { getClient, enabled, create, jsonOf, setClient, MODEL };
