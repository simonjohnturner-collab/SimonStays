// AI receipt reader. When a cleaner submits a checkout clean with a purchase
// photo (till slip / invoice), this reads the slip with a Claude vision model and
// records an itemised breakdown + total on the submission, and normalised
// PurchaseItem rows for later trend analysis (spend per cleaner/unit/property and
// when durable items were last replaced).
//
// Dormant-safe: with no ANTHROPIC_API_KEY (or SDK) it just marks the submission
// 'no_key' and does nothing else — nothing breaks.
const prisma = require('../lib/prisma');

let Anthropic = null;
try { const pkg = require('@anthropic-ai/sdk'); Anthropic = pkg && (pkg.default || pkg); } catch (e) { /* SDK not installed */ }

// Model is configurable via env so we can trade cost vs. accuracy without a deploy.
const MODEL = process.env.PURCHASE_MODEL || 'claude-opus-5';

// Buckets the model must classify each item into, so spend groups cleanly later.
const CATEGORIES = [
  'Cleaning supplies',
  'Toiletries & guest amenities',
  'Linen & towels',
  'Kitchenware & crockery',
  'Appliances & electronics',
  'Maintenance & hardware',
  'Groceries & consumables',
  'Decor & furniture',
  'Other',
];

const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const PURCHASE_FIELDS = ['buy_invoice', 'buy_items']; // receipt + item photos

const SYSTEM = [
  'You read South African retail till slips / receipts and return a clean, itemised breakdown.',
  'Prices are in South African rand (ZAR). Amounts must be returned in CENTS (integers): R24.99 -> 2499.',
  'Only list actual purchased products. Ignore VAT lines, subtotals, change, tender/card lines, loyalty points and store slogans.',
  'For each item\'s name, expand the cryptic till abbreviation into the normal, recognisable product name in ordinary casing (e.g. "HANDY ANDY CRM 750" -> "Handy Andy", "DOMESTOS 750ML" -> "Domestos", "SUNLGHT DISHWSH" -> "Sunlight dishwashing liquid"). Keep it faithful — do not invent a brand you cannot read; if unsure, use a plain description of what it is.',
  'Classify each item into exactly one of the given categories. Set isReplacement=true only for durable items that get replaced occasionally (kettle, iron, toaster, linen, towels, crockery, appliances, decor) — not for consumables like detergent or toilet paper.',
  'If the printed total does not match the sum of the line items, set totalsMatch=false. If the slip is too blurry/dark to read reliably, set readable=false and extract what you can.',
  'Also capture the slip\'s own reference number as invoiceNumber (labelled Invoice/Receipt/Slip/Tax Invoice/Doc No/Trans/Ref — pick the document number, not the till/cashier/store number), and the time of purchase as purchaseTime in 24-hour HH:MM. Use null for either if it is not printed or you cannot read it.',
  'IMPORTANT: a single photo may show more than one separate till slip — two receipts side by side, stacked, or overlapping. Return EACH distinct slip as its own entry in the receipts array; never merge two different slips (different store, invoice number, date or total) into one.',
  'Always call the record_receipts tool, with one entry per slip you can see.',
].join(' ');

// Schema for one till slip. The tool returns an array of these so several slips
// in a single photo each become their own receipt.
const RECEIPT_PROPS = {
  merchant: { type: ['string', 'null'], description: 'Store name on the slip, or null.' },
  invoiceNumber: { type: ['string', 'null'], description: 'The slip\'s own invoice / receipt / slip / document number, or null.' },
  purchaseDate: { type: ['string', 'null'], description: 'Date on the slip as YYYY-MM-DD, or null if not visible.' },
  purchaseTime: { type: ['string', 'null'], description: 'Time on the slip as HH:MM (24-hour), or null if not visible.' },
  items: {
    type: 'array',
    description: 'Every purchased line item on THIS slip.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: CATEGORIES },
        quantity: { type: 'number' },
        unitPriceCents: { type: ['integer', 'null'] },
        lineTotalCents: { type: ['integer', 'null'] },
        isReplacement: { type: 'boolean' },
      },
      required: ['name', 'category', 'quantity', 'unitPriceCents', 'lineTotalCents', 'isReplacement'],
    },
  },
  subtotalCents: { type: ['integer', 'null'] },
  totalCents: { type: ['integer', 'null'] },
  totalsMatch: { type: 'boolean' },
  readable: { type: 'boolean' },
  summary: { type: 'string', description: 'One short sentence summarising this slip.' },
};
const RECEIPT_REQUIRED = ['merchant', 'invoiceNumber', 'purchaseDate', 'purchaseTime', 'items', 'subtotalCents', 'totalCents', 'totalsMatch', 'readable', 'summary'];

const TOOL = {
  name: 'record_receipts',
  description: 'Record every till slip / invoice visible in the photo(s) — one entry per distinct slip.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      currency: { type: 'string', description: 'ISO currency code, e.g. ZAR.' },
      receipts: {
        type: 'array',
        description: 'One entry per distinct till slip/invoice visible across the photo(s). A single photo may contain more than one — split them.',
        items: { type: 'object', additionalProperties: false, properties: RECEIPT_PROPS, required: RECEIPT_REQUIRED },
      },
    },
    required: ['currency', 'receipts'],
  },
};

const enabled = () => !!(Anthropic && process.env.ANTHROPIC_API_KEY);
const mediaType = (ct) => (ALLOWED_MEDIA.has(ct) ? ct : 'image/jpeg');
const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const matchesField = (p, base) => { const f = p.fieldId || ''; return f === base || f.startsWith(base + '__'); };

async function setStatus(id, status) {
  try { await prisma.formSubmission.update({ where: { id }, data: { purchaseStatus: status } }); } catch (e) { /* row may be gone */ }
}

function purchasePhotos(sub) {
  return (sub.photos || []).filter((p) => {
    const f = p.fieldId || '';
    return PURCHASE_FIELDS.some((base) => f === base || f.startsWith(base + '__'));
  });
}

// True if this submission has at least one purchase photo (used by the finalize
// trigger to avoid spinning up the analyzer for a clean that bought nothing).
function hasPurchasePhotos(photos) {
  return (photos || []).some((p) => {
    const f = p.fieldId || '';
    return PURCHASE_FIELDS.some((base) => f === base || f.startsWith(base + '__'));
  });
}

async function analyzePurchase(submissionId) {
  let sub;
  try { sub = await prisma.formSubmission.findUnique({ where: { id: submissionId }, include: { photos: true } }); }
  catch (e) { console.error('[purchase] load failed:', e.message); return; }
  if (!sub) return;

  const photos = purchasePhotos(sub);
  if (!photos.length) { await setStatus(sub.id, 'none'); return; }
  if (!enabled()) { await setStatus(sub.id, 'no_key'); return; }

  await setStatus(sub.id, 'pending');
  try {
    const client = new Anthropic();

    // A cleaner may hand in several receipts. Analyse each invoice photo on its
    // OWN so every till slip gets its own itemised breakdown + total, instead of
    // being merged into a single lump — and each photo can itself yield more than
    // one slip (readReceipts returns an array). Item photos (buy_items) aren't
    // priced receipts, so they only stand in when no invoice photo was uploaded.
    const invoices = photos.filter((p) => matchesField(p, 'buy_invoice'));
    const itemsOnly = photos.filter((p) => !matchesField(p, 'buy_invoice'));
    const groups = invoices.length
      ? invoices.slice(0, 12).map((p) => [p])       // each invoice photo analysed on its own
      : (itemsOnly.length ? [itemsOnly.slice(0, 8)] : []); // fallback: item photos only

    const receipts = [];
    let usageIn = 0, usageOut = 0;
    for (const g of groups) {
      const r = await readReceipts(client, g);
      if (r && r.receipts.length) { receipts.push(...r.receipts); usageIn += r.usageIn; usageOut += r.usageOut; }
    }
    if (!receipts.length) throw new Error('no structured data returned');
    await store(sub, receipts, { input_tokens: usageIn, output_tokens: usageOut });
  } catch (e) {
    console.error('[purchase] analyze failed:', e && e.message);
    await setStatus(sub.id, 'failed');
  }
}

// Read a photo (or the item photos as a fallback) and return EVERY till slip on
// it — a single photo can hold more than one, so this returns an array.
async function readReceipts(client, photoGroup) {
  const images = photoGroup.map((p) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType(p.contentType), data: Buffer.from(p.data).toString('base64') },
  }));
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'auto' }, // 'auto' (not forced) stays compatible with adaptive thinking
    messages: [{ role: 'user', content: [...images, { type: 'text', text: 'Read every till slip / invoice in the attached photo(s). If a photo shows more than one separate slip, record each one on its own. Record every purchased item.' }] }],
  });
  const tu = (resp.content || []).find((b) => b.type === 'tool_use');
  const data = tu ? tu.input : parseJsonFromText(resp.content);
  const currency = (data && typeof data.currency === 'string' && data.currency.trim()) || 'ZAR';
  // New shape: { receipts: [...] }. Tolerate the old single-object shape too.
  let list = data && Array.isArray(data.receipts) ? data.receipts
    : (data && Array.isArray(data.items) ? [data] : []);
  list = list.filter((r) => r && Array.isArray(r.items));
  list.forEach((r) => { if (!r.currency) r.currency = currency; });
  return { receipts: list, usageIn: resp.usage ? resp.usage.input_tokens : 0, usageOut: resp.usage ? resp.usage.output_tokens : 0 };
}

// Fallback: pull a JSON object out of a text response if no tool_use came back.
function parseJsonFromText(content) {
  const text = (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const i = text.indexOf('{'); const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
}

// Aggregate one-or-more analysed receipts into a per-invoice display summary and
// a flat set of PurchaseItem rows (for trend analysis, which doesn't group).
async function store(sub, receipts, usage) {
  const currency = (receipts.map((d) => d && d.currency).find((c) => typeof c === 'string' && c.trim())) || 'ZAR';
  const rows = [];
  const displayReceipts = [];
  let grandTotal = 0; let anyTotal = false;
  const seenInvoices = new Set(); // drop the same invoice number twice (a re-photographed slip)
  let duplicatesDropped = 0;

  receipts.forEach((data) => {
    // Duplicate guard: if this slip's invoice number was already recorded, skip it
    // entirely so a receipt uploaded twice can't inflate the total.
    const invNoKey = (typeof data.invoiceNumber === 'string' && data.invoiceNumber.trim()) ? data.invoiceNumber.trim().toLowerCase() : null;
    if (invNoKey) { if (seenInvoices.has(invNoKey)) { duplicatesDropped++; return; } seenInvoices.add(invNoKey); }
    const items = Array.isArray(data.items) ? data.items : [];
    let purchasedAt = sub.createdAt;
    if (typeof data.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) {
      const d = new Date(data.purchaseDate + 'T12:00:00Z');
      if (!isNaN(d.getTime())) purchasedAt = d;
    }
    const rItems = items.slice(0, 300).map((it) => ({
      name: String(it && it.name ? it.name : 'Item').slice(0, 300),
      category: it && CATEGORIES.includes(it.category) ? it.category : 'Other',
      quantity: toNum(it && it.quantity) || 1,
      unitPriceCents: toInt(it && it.unitPriceCents),
      lineTotalCents: toInt(it && it.lineTotalCents),
      isReplacement: !!(it && it.isReplacement),
    }));
    rItems.forEach((it) => rows.push({
      hostId: sub.hostId, submissionId: sub.id, propertyId: sub.propertyId, unitId: sub.unitId,
      cleanerName: sub.submitterName || null, purchasedAt, currency, ...it,
    }));

    const printed = toInt(data.totalCents);
    const summed = rItems.reduce((a, it) => a + (it.lineTotalCents || 0), 0);
    const receiptTotal = printed != null ? printed : (rItems.length ? summed : null);
    if (receiptTotal != null) { grandTotal += receiptTotal; anyTotal = true; }

    const invoiceNumber = (typeof data.invoiceNumber === 'string' && data.invoiceNumber.trim()) ? data.invoiceNumber.trim().slice(0, 60) : null;
    const purchaseTime = (typeof data.purchaseTime === 'string' && /^\d{1,2}:\d{2}$/.test(data.purchaseTime.trim()))
      ? data.purchaseTime.trim().replace(/^(\d):/, '0$1:') : null;
    displayReceipts.push({
      merchant: data.merchant || null,
      invoiceNumber,
      purchaseDate: purchasedAt.toISOString().slice(0, 10),
      purchaseTime,
      items: rItems,
      subtotalCents: toInt(data.subtotalCents),
      totalCents: receiptTotal,
      totalsMatch: data.totalsMatch !== false,
      readable: data.readable !== false,
      summary: typeof data.summary === 'string' ? data.summary : '',
    });
  });

  const summary = {
    currency,
    receiptCount: displayReceipts.length,
    receipts: displayReceipts,
    duplicatesDropped,
    // Flat concatenation kept for backward-compatible readers of the old shape.
    items: displayReceipts.flatMap((r) => r.items),
    totalCents: anyTotal ? grandTotal : null,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    usage: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
  };

  await prisma.$transaction([
    prisma.purchaseItem.deleteMany({ where: { submissionId: sub.id } }),
    ...(rows.length ? [prisma.purchaseItem.createMany({ data: rows.slice(0, 600) })] : []),
    prisma.formSubmission.update({ where: { id: sub.id }, data: { purchaseSummary: summary, purchaseStatus: 'done' } }),
  ]);
}

// Light display shape for one receipt, used by the live cleaner preview (no DB).
function previewReceipt(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const rItems = items.slice(0, 300).map((it) => ({
    name: String(it && it.name ? it.name : 'Item').slice(0, 300),
    category: it && CATEGORIES.includes(it.category) ? it.category : 'Other',
    quantity: toNum(it && it.quantity) || 1,
    lineTotalCents: toInt(it && it.lineTotalCents),
    unitPriceCents: toInt(it && it.unitPriceCents),
    isReplacement: !!(it && it.isReplacement),
  }));
  const printed = toInt(data.totalCents);
  const summed = rItems.reduce((a, it) => a + (it.lineTotalCents || 0), 0);
  const total = printed != null ? printed : (rItems.length ? summed : null);
  const invoiceNumber = (typeof data.invoiceNumber === 'string' && data.invoiceNumber.trim()) ? data.invoiceNumber.trim().slice(0, 60) : null;
  const purchaseTime = (typeof data.purchaseTime === 'string' && /^\d{1,2}:\d{2}$/.test(data.purchaseTime.trim())) ? data.purchaseTime.trim().replace(/^(\d):/, '0$1:') : null;
  const purchaseDate = (typeof data.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) ? data.purchaseDate : null;
  return { merchant: data.merchant || null, invoiceNumber, purchaseDate, purchaseTime, items: rItems, totalCents: total, readable: data.readable !== false };
}

const MAX_IMG_BYTES = 12 * 1024 * 1024;
function decodeImage(dataBase64) {
  if (typeof dataBase64 !== 'string') return null;
  const b64 = dataBase64.indexOf(',') >= 0 ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64;
  try { const buf = Buffer.from(b64, 'base64'); return (buf.length && buf.length <= MAX_IMG_BYTES) ? buf : null; } catch (e) { return null; }
}

// Stateless: read invoice image(s) and return the receipt breakdown WITHOUT touching
// the DB. Powers the public cleaner form's live "what you're owed" summary as she
// uploads — the authoritative, stored record is still built on submit via store().
async function analyzeInvoiceImages(images) {
  if (!enabled()) return { ok: false, reason: 'no_key' };
  try {
    const client = new Anthropic();
    const receipts = [];
    for (const im of (Array.isArray(images) ? images : []).slice(0, 4)) {
      const buf = decodeImage(im && im.dataBase64);
      if (!buf) continue;
      const r = await readReceipts(client, [{ data: buf, contentType: (im && im.contentType) || 'image/jpeg' }]);
      ((r && r.receipts) || []).forEach((rc) => receipts.push(previewReceipt(rc)));
    }
    return { ok: true, currency: 'ZAR', receipts };
  } catch (e) {
    console.error('[purchase] preview failed:', e && e.message);
    return { ok: false, reason: 'failed' };
  }
}

module.exports = { analyzePurchase, hasPurchasePhotos, enabled, analyzeInvoiceImages, MODEL, CATEGORIES };
