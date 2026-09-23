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
  'Always call the record_purchase tool with your result.',
].join(' ');

const TOOL = {
  name: 'record_purchase',
  description: 'Record the itemised contents of a purchase receipt / till slip.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      merchant: { type: ['string', 'null'], description: 'Store name on the slip, or null.' },
      invoiceNumber: { type: ['string', 'null'], description: 'The slip\'s own invoice / receipt / slip / document number, or null.' },
      purchaseDate: { type: ['string', 'null'], description: 'Date on the slip as YYYY-MM-DD, or null if not visible.' },
      purchaseTime: { type: ['string', 'null'], description: 'Time on the slip as HH:MM (24-hour), or null if not visible.' },
      currency: { type: 'string', description: 'ISO currency code, e.g. ZAR.' },
      items: {
        type: 'array',
        description: 'Every purchased line item.',
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
      summary: { type: 'string', description: 'One short sentence summarising the purchase.' },
    },
    required: ['merchant', 'invoiceNumber', 'purchaseDate', 'purchaseTime', 'currency', 'items', 'subtotalCents', 'totalCents', 'totalsMatch', 'readable', 'summary'],
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
    // being merged into a single lump. Item photos (buy_items) aren't priced
    // receipts, so they only stand in when no invoice photo was uploaded.
    const invoices = photos.filter((p) => matchesField(p, 'buy_invoice'));
    const itemsOnly = photos.filter((p) => !matchesField(p, 'buy_invoice'));
    const groups = invoices.length
      ? invoices.slice(0, 12).map((p) => [p])       // one receipt per invoice photo
      : (itemsOnly.length ? [itemsOnly.slice(0, 8)] : []); // fallback: item photos only

    const receipts = [];
    let usageIn = 0, usageOut = 0;
    for (const g of groups) {
      const r = await readOneReceipt(client, g);
      if (r) { receipts.push(r.data); usageIn += r.usageIn; usageOut += r.usageOut; }
    }
    if (!receipts.length) throw new Error('no structured data returned');
    await store(sub, receipts, { input_tokens: usageIn, output_tokens: usageOut });
  } catch (e) {
    console.error('[purchase] analyze failed:', e && e.message);
    await setStatus(sub.id, 'failed');
  }
}

// Read a single receipt (one invoice photo, or the item photos as a fallback).
async function readOneReceipt(client, photoGroup) {
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
    messages: [{ role: 'user', content: [...images, { type: 'text', text: 'Read this ONE till slip / invoice and record every purchased item on it.' }] }],
  });
  const tu = (resp.content || []).find((b) => b.type === 'tool_use');
  const data = tu ? tu.input : parseJsonFromText(resp.content);
  if (!data || !Array.isArray(data.items)) return null;
  return { data, usageIn: resp.usage ? resp.usage.input_tokens : 0, usageOut: resp.usage ? resp.usage.output_tokens : 0 };
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

  receipts.forEach((data) => {
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

module.exports = { analyzePurchase, hasPurchasePhotos, enabled, MODEL, CATEGORIES };
