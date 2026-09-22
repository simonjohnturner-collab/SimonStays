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
  'Classify each item into exactly one of the given categories. Set isReplacement=true only for durable items that get replaced occasionally (kettle, iron, toaster, linen, towels, crockery, appliances, decor) — not for consumables like detergent or toilet paper.',
  'If the printed total does not match the sum of the line items, set totalsMatch=false. If the slip is too blurry/dark to read reliably, set readable=false and extract what you can.',
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
      purchaseDate: { type: ['string', 'null'], description: 'Date on the slip as YYYY-MM-DD, or null if not visible.' },
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
    required: ['merchant', 'purchaseDate', 'currency', 'items', 'subtotalCents', 'totalCents', 'totalsMatch', 'readable', 'summary'],
  },
};

const enabled = () => !!(Anthropic && process.env.ANTHROPIC_API_KEY);
const mediaType = (ct) => (ALLOWED_MEDIA.has(ct) ? ct : 'image/jpeg');
const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

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
    const images = photos.slice(0, 8).map((p) => ({
      type: 'image',
      source: { type: 'base64', media_type: mediaType(p.contentType), data: Buffer.from(p.data).toString('base64') },
    }));
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'auto' }, // 'auto' (not forced) stays compatible with adaptive thinking
      messages: [{ role: 'user', content: [...images, { type: 'text', text: 'Read the attached till slip(s) and record every purchased item.' }] }],
    });
    const tu = (resp.content || []).find((b) => b.type === 'tool_use');
    const data = tu ? tu.input : parseJsonFromText(resp.content);
    if (!data || !Array.isArray(data.items)) throw new Error('no structured data returned');
    await store(sub, data, resp.usage);
  } catch (e) {
    console.error('[purchase] analyze failed:', e && e.message);
    await setStatus(sub.id, 'failed');
  }
}

// Fallback: pull a JSON object out of a text response if no tool_use came back.
function parseJsonFromText(content) {
  const text = (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const i = text.indexOf('{'); const j = text.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
}

async function store(sub, data, usage) {
  const items = Array.isArray(data.items) ? data.items : [];
  const currency = (typeof data.currency === 'string' && data.currency.trim()) || 'ZAR';
  let purchasedAt = sub.createdAt;
  if (typeof data.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) {
    const d = new Date(data.purchaseDate + 'T12:00:00Z');
    if (!isNaN(d.getTime())) purchasedAt = d;
  }
  const rows = items.slice(0, 300).map((it) => ({
    hostId: sub.hostId,
    submissionId: sub.id,
    propertyId: sub.propertyId,
    unitId: sub.unitId,
    cleanerName: sub.submitterName || null,
    purchasedAt,
    name: String(it && it.name ? it.name : 'Item').slice(0, 300),
    category: it && CATEGORIES.includes(it.category) ? it.category : 'Other',
    quantity: toNum(it && it.quantity) || 1,
    unitPriceCents: toInt(it && it.unitPriceCents),
    lineTotalCents: toInt(it && it.lineTotalCents),
    currency,
    isReplacement: !!(it && it.isReplacement),
  }));

  const summary = {
    merchant: data.merchant || null,
    purchaseDate: purchasedAt.toISOString().slice(0, 10),
    currency,
    items: rows.map((r) => ({ name: r.name, category: r.category, quantity: r.quantity, unitPriceCents: r.unitPriceCents, lineTotalCents: r.lineTotalCents, isReplacement: r.isReplacement })),
    subtotalCents: toInt(data.subtotalCents),
    totalCents: toInt(data.totalCents),
    totalsMatch: data.totalsMatch !== false,
    readable: data.readable !== false,
    summary: typeof data.summary === 'string' ? data.summary : '',
    model: MODEL,
    generatedAt: new Date().toISOString(),
    usage: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
  };

  await prisma.$transaction([
    prisma.purchaseItem.deleteMany({ where: { submissionId: sub.id } }),
    ...(rows.length ? [prisma.purchaseItem.createMany({ data: rows })] : []),
    prisma.formSubmission.update({ where: { id: sub.id }, data: { purchaseSummary: summary, purchaseStatus: 'done' } }),
  ]);
}

module.exports = { analyzePurchase, hasPurchasePhotos, enabled, MODEL, CATEGORIES };
