const prisma = require('../lib/prisma');

// Sections whose photo uploads are mandatory — a checkout must document each of
// these rooms (bathroom, bedroom, kitchen, living/dining). Photos in any OTHER
// section (Guests, patio, purchases, breakage, general) are optional so they
// never block a cleaner's submission.
const ROOM_RE = /bathroom|bedroom|kitchen|living|lounge|dining/i;
const KITCHEN_RE = /kitchen/i;
const KITCHEN_PHOTO_LABEL = 'Please upload photos of the kitchen — include the fridge, microwave and oven, and the cupboards showing the plates, glasses and mugs.';
const GUEST_RE = /guest/i;
const GUEST_PHOTO_ID = 'guest_left_photos';
const guestPhotoField = () => ({ id: GUEST_PHOTO_ID, label: 'Photos of anything the guest left behind', type: 'photos', required: false });

// The glassware/crockery question: its count must be 2 x bedrooms (a 2-bed -> 4
// of each), not the sleeps capacity. We retoken {sleeps} -> {crockery} in that
// one question (clean.html renders {crockery} as 2 x bedrooms) and add a matching
// check right after it. Match only labels that use {sleeps} AND name crockery, so
// the kitchen photo prompt (which also says "plates, glasses") is left alone.
const CROCKERY_RE = /glass|beer|wine|crockery|cutlery|plate|bowl/i;
const MATCHING_ID = 'crockery_matching';
const matchingField = (base) => ({ id: MATCHING_ID, label: 'Dinner plates, side plates and bowls — are they all matching?', type: (base && base.type) || 'checkbox', required: false });

// Purchases + Damaged-items are rebuilt to a canonical shape and moved to the end:
//   • Purchases (variant 'accent') stands out: what was bought, then a photo of the
//     item(s) and a photo of the receipt/invoice. All optional (a clean may buy nothing).
//   • Damaged items (repeat 'ondemand', variant 'warn') lets the cleaner tap "Add a
//     damaged item" one or more times, each a photo + short description.
// The photos here stay required:false at the template level ON PURPOSE — finalize
// treats any required photo field as needed on EVERY clean, which would block a
// clean with no damage/purchase. clean.html makes each ADDED damaged item's fields
// required client-side instead, so an added item can't be left blank.
const PURCHASE_SEC_RE = /purchas/i;
const DAMAGE_SEC_RE = /damage|breakage|broken/i;
const DROP_LOOSE_IDS = new Set(['c_purchases', 'c_photos', 'buy_desc', 'buy_items', 'buy_invoice', 'dmg_photo', 'dmg_desc']);
const PURCHASE_FIELD_RE = /purchas|proof of purchase|receipt|invoice/i;
const purchasesSection = () => ([
  { type: 'section', id: 'sec_purchases', label: 'Purchases', variant: 'accent' },
  { id: 'buy_desc', label: 'What did you buy? Item(s) and cost', type: 'textarea', required: false },
  { id: 'buy_items', label: 'Photo of the purchased item(s)', type: 'photos', required: false },
  { id: 'buy_invoice', label: 'Photo of the receipt / invoice (proof of purchase)', type: 'photos', required: false },
]);
const damagedSection = () => ([
  { type: 'section', id: 'sec_damaged', label: 'Damaged items', repeat: 'ondemand', addLabel: 'Add a damaged item', variant: 'warn' },
  { id: 'dmg_photo', label: 'Photo of the damaged item', type: 'photos', required: false },
  { id: 'dmg_desc', label: 'Brief description of the damage', type: 'text', required: false },
]);
// Strip any existing purchases/damage sections (and old loose purchase fields),
// then append the canonical Purchases + Damaged-items sections at the end.
function reshapePurchasesAndDamage(fields) {
  const groups = []; let cur = { section: null, fields: [] };
  for (const f of fields) {
    if (f && f.type === 'section') { if (cur.section || cur.fields.length) groups.push(cur); cur = { section: f, fields: [] }; }
    else cur.fields.push(f);
  }
  if (cur.section || cur.fields.length) groups.push(cur);

  const kept = [];
  for (const g of groups) {
    if (g.section) {
      const lbl = g.section.label || '';
      if (PURCHASE_SEC_RE.test(lbl) || DAMAGE_SEC_RE.test(lbl)) continue; // replaced below
      kept.push(g.section);
      for (const f of g.fields) kept.push(f);
    } else {
      for (const f of g.fields) { // leading loose fields: drop old purchase ones, keep the rest (e.g. c_notes)
        if (!f) continue;
        if (DROP_LOOSE_IDS.has(f.id)) continue;
        if (f.type === 'photos' && PURCHASE_FIELD_RE.test(f.label || '')) continue;
        kept.push(f);
      }
    }
  }
  return kept.concat(purchasesSection(), damagedSection());
}

// Idempotently normalise every clean template:
//   • photos are REQUIRED only inside room sections, optional everywhere else
//   • the kitchen photo prompt names the specific items to photograph
//   • the Guests section gains one optional "anything the guest left" photo field
//   • the glassware count question switches {sleeps} -> {crockery} (2 x bedrooms)
//     and gains a "are the plates/bowls all matching?" check right after it
//   • Purchases + Damaged-items sections are rebuilt to a canonical shape and moved
//     to the end (see reshapePurchasesAndDamage)
// Runs on startup; safe to run repeatedly (only writes when something changed).
async function normaliseCleanForms() {
  let templates;
  try { templates = await prisma.formTemplate.findMany({ where: { type: 'clean' } }); }
  catch (e) { console.error('[forms] migration skipped:', e.message); return 0; }

  let changed = 0;
  for (const t of templates) {
    const fields = Array.isArray(t.fields) ? t.fields : [];
    const hasGuestPhoto = fields.some((f) => f && f.id === GUEST_PHOTO_ID);
    let hasMatching = fields.some((f) => f && f.id === MATCHING_ID);
    let inRoom = false, inGuest = false, inKitchen = false, guestAdded = hasGuestPhoto, dirty = false;
    const out = [];

    for (const f of fields) {
      if (f && f.type === 'section') {
        if (inGuest && !guestAdded) { out.push(guestPhotoField()); guestAdded = true; dirty = true; }
        inRoom = ROOM_RE.test(f.label || '');
        inGuest = GUEST_RE.test(f.label || '');
        inKitchen = KITCHEN_RE.test(f.label || '');
        out.push(f);
        continue;
      }
      if (f && f.type === 'photos') {
        const wantLabel = inKitchen ? KITCHEN_PHOTO_LABEL : f.label;
        if (!!f.required !== inRoom || f.label !== wantLabel) { out.push({ ...f, required: inRoom, label: wantLabel }); dirty = true; continue; }
      }
      if (f && typeof f.label === 'string' && f.label.includes('{sleeps}') && CROCKERY_RE.test(f.label)) {
        const retoken = { ...f, label: f.label.replace(/\{sleeps\}/g, '{crockery}') };
        if (retoken.label !== f.label) dirty = true;
        out.push(retoken);
        if (!hasMatching) { out.push(matchingField(f)); hasMatching = true; dirty = true; }
        continue;
      }
      out.push(f);
    }
    // Guests may be the last section in the form.
    if (inGuest && !guestAdded) { out.push(guestPhotoField()); dirty = true; }

    // Rebuild the Purchases + Damaged-items sections (idempotent: only writes when
    // the resulting fields differ from what's stored).
    const finalFields = reshapePurchasesAndDamage(out);
    if (dirty || JSON.stringify(finalFields) !== JSON.stringify(fields)) {
      await prisma.formTemplate.update({ where: { id: t.id }, data: { fields: finalFields } });
      changed++;
    }
  }
  if (changed) console.log(`[forms] normalised ${changed} clean template(s)`);
  return changed;
}

// Seed the ServiceProvider directory from each host's legacy cleaner-name list
// (role = Cleaner), once — only when the host has no providers yet. Idempotent.
async function seedServiceProviders() {
  let hosts;
  try { hosts = await prisma.host.findMany({ select: { id: true, cleaners: true } }); }
  catch (e) { console.error('[providers] seed skipped:', e.message); return 0; }
  let created = 0;
  for (const h of hosts) {
    const names = Array.isArray(h.cleaners) ? h.cleaners.filter((n) => typeof n === 'string' && n.trim()) : [];
    if (!names.length) continue;
    const count = await prisma.serviceProvider.count({ where: { hostId: h.id } });
    if (count > 0) continue; // already has a directory — don't duplicate
    await prisma.serviceProvider.createMany({ data: names.map((name) => ({ hostId: h.id, name: name.trim(), role: 'Cleaner' })) });
    created += names.length;
  }
  if (created) console.log(`[providers] seeded ${created} cleaner(s) into the service-provider directory`);
  return created;
}

// Seed each property's per-clean cleaner fee (cleanRateCents) once — only where
// it hasn't been set yet, so it never stomps a rate the host has edited.
// Starting balances: R350/clean everywhere, R400 for Morning Sun Gardens and the
// Four Protea Place (Plettenberg Bay) properties. Matched by name, case-insensitive.
async function seedCleanRates() {
  const DEFAULT = 35000; // R350.00
  const rateFor = (name) => (/morning sun/i.test(name) || /protea/i.test(name)) ? 40000 : DEFAULT;
  let props;
  try { props = await prisma.property.findMany({ where: { cleanRateCents: null }, select: { id: true, name: true } }); }
  catch (e) { console.error('[cleanrate] seed skipped:', e.message); return 0; }
  let set = 0;
  for (const p of props) {
    await prisma.property.update({ where: { id: p.id }, data: { cleanRateCents: rateFor(p.name || '') } });
    set++;
  }
  if (set) console.log(`[cleanrate] seeded per-clean fee on ${set} propertie(s)`);
  return set;
}

module.exports = { normaliseCleanForms, seedServiceProviders, seedCleanRates };
