// Paygate PayWeb3 (hosted payment page) — initiate a transaction, check the
// checksums Paygate signs its messages with, and query a transaction's outcome.
// Follows docs.paygate.co.za (PayWeb3: Initiate, Redirect, Notify, Query, Security).
//
// Env:
//   PAYMENT_MODE   simulate (default) | sandbox | live
//   PAYGATE_ID     \ from the Paygate Merchant Access Portal (PayWeb settings).
//   PAYGATE_KEY    / The encryption key is what makes every checksum unforgeable.
//   PAYGATE_PAYHOST_PASSWORD  the PayHost password ("PayHost encryption key"), set in
//                  the Merchant Access Portal once Paygate has enabled PayHost. Only
//                  refunds use it; payments still go through PayWeb3.
// Sandbox uses Paygate's published test account unless these are set.
const crypto = require('crypto');

const BASE = 'https://secure.paygate.co.za/payweb3';
const PROCESS_URL = `${BASE}/process.trans`;
// Paygate's published test merchant (docs: PayWeb3 Testing) — no real money.
const TEST = { paygateId: '10011072130', key: 'secret', payhostPassword: 'test' };
const PAYHOST_URL = 'https://secure.paygate.co.za/payhost/process.trans';

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
  const env = { paygateId: t(process.env.PAYGATE_ID), key: t(process.env.PAYGATE_KEY), payhostPassword: t(process.env.PAYGATE_PAYHOST_PASSWORD) };
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
    form: { action: PROCESS_URL, fields: { PAY_REQUEST_ID: r.PAY_REQUEST_ID, CHECKSUM: r.CHECKSUM } },
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

// ---- PayHost refunds (SOAP). Paygate, 2026-11-06: a PayWeb3 payment can be refunded
// through PayHost by its TransactionId or MerchantOrderId; partial refunds are allowed;
// the money comes from our bank account (50c fee) and the bank actions it. A good reply
// is StatusName Completed, ResultCode 990005 "Request for Refund Received",
// TransactionStatusCode 5 "Received by PayGate".
function refundsReady() {
  const c = config();
  return c.mode === 'simulate' || !!(c.paygateId && c.payhostPassword);
}

const xmlEsc = (v) => String(v).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
// The text of the first <Tag> (any namespace prefix) in `xml`, or null.
function tag(xml, name) {
  const m = new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?' + name + '>').exec(xml);
  return m ? m[1].trim() : null;
}

function refundEnvelope({ paygateId, password, transactionId, amountCents }) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body>'
    + '<SingleFollowUpRequest xmlns="http://www.paygate.co.za/PayHOST"><RefundRequest>'
    + `<Account><PayGateId>${xmlEsc(paygateId)}</PayGateId><Password>${xmlEsc(password)}</Password></Account>`
    + `<TransactionId>${xmlEsc(transactionId)}</TransactionId><Amount>${Math.round(amountCents)}</Amount>`
    + '</RefundRequest></SingleFollowUpRequest></SOAP-ENV:Body></SOAP-ENV:Envelope>';
}

// Read Paygate's reply to a refund. outcome:
//   'sent'     Paygate has the refund and passes it to the bank.
//   'rejected' Paygate refused it — no money moved, safe to try again or pay by hand.
//   'unclear'  anything else. The refund may or may not have gone through, so it must
//              be checked with Paygate and is never resent automatically.
function readRefundReply(httpStatus, xml) {
  const body = String(xml || '');
  const fault = tag(body, 'faultstring');
  const reply = {
    statusName: tag(body, 'StatusName'), resultCode: tag(body, 'ResultCode'),
    resultDescription: tag(body, 'ResultDescription'), transactionStatusCode: tag(body, 'TransactionStatusCode'),
    transactionStatusDescription: tag(body, 'TransactionStatusDescription'),
    transactionId: tag(body, 'TransactionId'), payRequestId: tag(body, 'PayRequestId'),
    amountCents: tag(body, 'Amount') != null ? Number(tag(body, 'Amount')) : null,
    dateTime: tag(body, 'DateTime'), fault, httpStatus,
  };
  const why = reply.resultDescription || reply.transactionStatusDescription || fault || reply.statusName || `HTTP ${httpStatus}`;
  if (reply.statusName === 'Completed' && (reply.resultCode === '990005' || ['1', '5'].includes(reply.transactionStatusCode))) return { outcome: 'sent', reply, message: why };
  // A SOAP fault or a validation/decline answer means Paygate did not take the request.
  if (fault || ['Error', 'ValidationError'].includes(reply.statusName) || ['2', '3', '4'].includes(reply.transactionStatusCode)) return { outcome: 'rejected', reply, message: why };
  return { outcome: 'unclear', reply, message: why };
}

// Refund `amountCents` of the PayWeb3 payment with Paygate TRANSACTION_ID `transactionId`.
// Never throws: network errors and timeouts come back as 'unclear'.
async function refund({ transactionId, amountCents }, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const c = config();
  if (c.mode === 'simulate') return { outcome: 'sent', reply: { simulated: true, transactionId: `SIM-${Date.now()}`, resultCode: '990005' }, message: 'Simulated refund' };
  if (!c.paygateId || !c.payhostPassword) return { outcome: 'rejected', reply: null, message: 'PayHost is not set up: PAYGATE_PAYHOST_PASSWORD is missing.' };
  if (!transactionId) return { outcome: 'rejected', reply: null, message: 'The original payment has no Paygate transaction ID.' };
  if (!Number.isInteger(amountCents) || amountCents < 1) return { outcome: 'rejected', reply: null, message: 'Bad refund amount.' };
  let res; let text;
  try {
    res = await fetchImpl(PAYHOST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'SingleFollowUp' },
      body: refundEnvelope({ paygateId: c.paygateId, password: c.payhostPassword, transactionId, amountCents }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { outcome: 'unclear', reply: { error: e.message }, message: `No reply from Paygate (${e.name === 'TimeoutError' ? 'timed out' : e.message})` };
  }
  const r = readRefundReply(res.status, text);
  // Paygate's firewall (403) refuses before anything is processed.
  if (r.outcome === 'unclear' && res.status === 403) return { ...r, outcome: 'rejected', message: 'Paygate refused the connection (HTTP 403)' };
  if (r.outcome !== 'sent') console.warn('[paygate] refund', r.outcome, transactionId, r.message, text.slice(0, 1000));
  return r;
}

// Check the PayHost password by asking Paygate to refund a transaction that doesn't
// exist (TransactionId 0, 1 cent). "Unable To Find Original Transaction" (result 201)
// means Paygate accepted our login and looked for it, so nothing moves and the key
// is right. Logs a plain-English result for the Render logs.
async function payhostSelfTest({ refundImpl = refund } = {}) {
  const c = config();
  if (c.mode === 'simulate') return { ok: true, skipped: true };
  const who = `mode=${c.mode} PAYGATE_ID=…${String(c.paygateId).slice(-4)} password=${(c.payhostPassword || '').length} chars`;
  if (!c.payhostPassword) { console.warn(`[paygate] PayHost self-test: PAYGATE_PAYHOST_PASSWORD missing (${who}) — card refunds are OFF, pay refunds by hand`); return { ok: false, missing: true }; }
  const r = await refundImpl({ transactionId: '0', amountCents: 1 });
  const code = r.reply && r.reply.resultCode;
  if (r.outcome === 'rejected' && code === '201') {
    console.log(`[paygate] PayHost self-test OK (${who}) — card refunds are ready`);
    return { ok: true };
  }
  console.error(`[paygate] PayHost self-test FAILED (${who}): ${r.outcome}, result ${code || '—'}: ${r.message} — check the PayHost encryption key in the Merchant Access Portal (Administration → Product Configuration → PayHost) matches PAYGATE_PAYHOST_PASSWORD`);
  return { ok: false, outcome: r.outcome, resultCode: code || null, message: r.message };
}

module.exports = {
  payhostSelfTest,
  mode, config, ready, initiate, query, validPayload, checksum, md5, txDate, selfTest, STATUS, TEST, PROCESS_URL,
  refund, refundsReady, readRefundReply, refundEnvelope, PAYHOST_URL,
};
