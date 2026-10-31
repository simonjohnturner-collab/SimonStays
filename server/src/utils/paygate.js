// Paygate PayWeb3 (hosted payment page) — initiate a transaction, check the
// checksums Paygate signs its messages with, and query a transaction's outcome.
// Follows docs.paygate.co.za (PayWeb3: Initiate, Redirect, Notify, Query, Security).
//
// Env:
//   PAYMENT_MODE   simulate (default) | sandbox | live
//   PAYGATE_ID     \ from the Paygate Merchant Access Portal (PayWeb settings).
//   PAYGATE_KEY    / The encryption key is what makes every checksum unforgeable.
// Sandbox uses Paygate's published test account unless these are set.
const crypto = require('crypto');

const BASE = 'https://secure.paygate.co.za/payweb3';
// Paygate's published test merchant (docs: PayWeb3 Testing) — no real money.
const TEST = { paygateId: '10011072130', key: 'secret' };

// Initiate fields in checksum order (docs: Security and Checksum Validation).
const INITIATE_ORDER = [
  'PAYGATE_ID', 'REFERENCE', 'AMOUNT', 'CURRENCY', 'RETURN_URL', 'TRANSACTION_DATE', 'LOCALE',
  'COUNTRY', 'EMAIL', 'PAY_METHOD', 'PAY_METHOD_DETAIL', 'NOTIFY_URL', 'USER1', 'USER2', 'USER3',
  'VAULT', 'VAULT_ID',
];

// TRANSACTION_STATUS codes (docs: Transaction Status Codes).
const STATUS = { 0: 'NOT_DONE', 1: 'APPROVED', 2: 'DECLINED', 3: 'CANCELLED', 4: 'USER_CANCELLED', 5: 'RECEIVED', 7: 'VOIDED' };

function mode() {
  const m = (process.env.PAYMENT_MODE || 'simulate').toLowerCase();
  return m === 'live' || m === 'sandbox' ? m : 'simulate';
}
function config() {
  const m = mode();
  const t = (v) => (v || '').trim();
  const env = { paygateId: t(process.env.PAYGATE_ID), key: t(process.env.PAYGATE_KEY) };
  return { mode: m, ...(m === 'sandbox' && !env.paygateId ? TEST : env) };
}
function ready() {
  const c = config();
  return c.mode !== 'simulate' && !!(c.paygateId && c.key);
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
// A checksum is the field values concatenated (no separators) + the key, MD5'd.
const checksum = (values, key) => md5(values.map((v) => (v == null ? '' : String(v))).join('') + key);

async function post(path, fields) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  // Paygate's firewall answers 403 for e.g. localhost return/notify URLs.
  if (!res.ok) throw new Error(`Paygate ${path} HTTP ${res.status}`);
  return Object.fromEntries(new URLSearchParams(text.trim()));
}

// UTC 'YYYY-MM-DD HH:mm:ss'.
const txDate = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

// Start a transaction. Returns { payRequestId, form: { action, fields } } — the
// browser posts the form to Paygate's payment page.
async function initiate({ reference, amountCents, email, returnUrl, notifyUrl, user1 }) {
  const c = config();
  const f = {
    PAYGATE_ID: c.paygateId, REFERENCE: reference, AMOUNT: String(Math.round(amountCents)), CURRENCY: 'ZAR',
    RETURN_URL: returnUrl, TRANSACTION_DATE: txDate(), LOCALE: 'en-za', COUNTRY: 'ZAF', EMAIL: email,
    NOTIFY_URL: notifyUrl, USER1: user1,
  };
  for (const k of Object.keys(f)) if (f[k] === undefined || f[k] === null || f[k] === '') delete f[k];
  f.CHECKSUM = checksum(INITIATE_ORDER.filter((k) => k in f).map((k) => f[k]), c.key);
  const r = await post('initiate.trans', f);
  if (r.ERROR || !r.PAY_REQUEST_ID) throw new Error(`Paygate initiate failed: ${r.ERROR || 'no PAY_REQUEST_ID'}`);
  if (r.CHECKSUM !== checksum([r.PAYGATE_ID, r.PAY_REQUEST_ID, r.REFERENCE], c.key)) throw new Error('Paygate initiate: bad response checksum');
  return {
    payRequestId: r.PAY_REQUEST_ID,
    form: { action: `${BASE}/process.trans`, fields: { PAY_REQUEST_ID: r.PAY_REQUEST_ID, CHECKSUM: r.CHECKSUM } },
  };
}

// Is a Notify (or Query) payload genuinely from Paygate? Its checksum covers
// every field in the order sent (except CHECKSUM) + the key.
function validPayload(rawOrObj) {
  const c = config();
  const entries = typeof rawOrObj === 'string' ? [...new URLSearchParams(rawOrObj)] : Object.entries(rawOrObj);
  const sent = entries.find(([k]) => k === 'CHECKSUM');
  if (!sent) return false;
  return sent[1] === checksum(entries.filter(([k]) => k !== 'CHECKSUM').map(([, v]) => v), c.key);
}

// Ask Paygate for a transaction's outcome — the authoritative answer.
// Returns { status: 'APPROVED'|..., amountCents, data } or { status: 'PENDING' }
// while Paygate has nothing to report yet.
async function query({ payRequestId, reference }) {
  const c = config();
  const f = { PAYGATE_ID: c.paygateId, PAY_REQUEST_ID: payRequestId, REFERENCE: reference };
  f.CHECKSUM = checksum([f.PAYGATE_ID, f.PAY_REQUEST_ID, f.REFERENCE], c.key);
  const r = await post('query.trans', f);
  if (r.ERROR === 'NO_TRANS_DATA') return { status: 'PENDING' };
  if (r.ERROR) throw new Error(`Paygate query failed: ${r.ERROR}`);
  if (!validPayload(r)) throw new Error('Paygate query: bad response checksum');
  if (r.PAYGATE_ID !== c.paygateId || r.PAY_REQUEST_ID !== payRequestId || r.REFERENCE !== reference) throw new Error('Paygate query: mismatched transaction');
  return { status: STATUS[r.TRANSACTION_STATUS] || `STATUS_${r.TRANSACTION_STATUS}`, amountCents: Number(r.AMOUNT), data: r };
}

// Check the PAYGATE_ID + PAYGATE_KEY pair by starting (never completing) a R1
// transaction — no money moves. Logs a plain-English result for the Render logs.
async function selfTest(base) {
  const c = config();
  if (c.mode === 'simulate') return { ok: true, skipped: true };
  const who = `mode=${c.mode} PAYGATE_ID=…${String(c.paygateId).slice(-4)} key=${c.key.length} chars`;
  if (!c.paygateId || !c.key) { console.warn(`[paygate] self-test: PAYGATE_ID / PAYGATE_KEY missing (${who}) — card payments are OFF`); return { ok: false }; }
  const site = (base || 'https://simonstays.co.za').replace(/\/$/, '');
  try {
    await initiate({ reference: `selftest-${Date.now()}`, amountCents: 100, email: 'selftest@simonstays.co.za', returnUrl: `${site}/`, notifyUrl: `${site}/public/paygate/notify` });
    console.log(`[paygate] self-test OK (${who}) — card payments are ready`);
    return { ok: true };
  } catch (e) {
    const hint = /DATA_CHK/.test(e.message)
      ? 'the PAYGATE_KEY does not match the encryption key Paygate has for this PAYGATE_ID'
      : /PGID_NOT_EN|PGID/.test(e.message) ? 'this PAYGATE_ID is not enabled for PayWeb3 — ask Paygate to activate it'
        : 'see the error';
    console.error(`[paygate] self-test FAILED (${who}): ${e.message} — ${hint}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { mode, config, ready, initiate, query, validPayload, checksum, md5, txDate, selfTest, STATUS, TEST };
