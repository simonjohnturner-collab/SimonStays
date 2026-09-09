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

// Idempotently normalise every clean template:
//   • photos are REQUIRED only inside room sections, optional everywhere else
//   • the kitchen photo prompt names the specific items to photograph
//   • the Guests section gains one optional "anything the guest left" photo field
// Runs on startup; safe to run repeatedly (only writes when something changed).
async function normaliseCleanForms() {
  let templates;
  try { templates = await prisma.formTemplate.findMany({ where: { type: 'clean' } }); }
  catch (e) { console.error('[forms] migration skipped:', e.message); return 0; }

  let changed = 0;
  for (const t of templates) {
    const fields = Array.isArray(t.fields) ? t.fields : [];
    const hasGuestPhoto = fields.some((f) => f && f.id === GUEST_PHOTO_ID);
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
      out.push(f);
    }
    // Guests may be the last section in the form.
    if (inGuest && !guestAdded) { out.push(guestPhotoField()); dirty = true; }

    if (dirty) { await prisma.formTemplate.update({ where: { id: t.id }, data: { fields: out } }); changed++; }
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

module.exports = { normaliseCleanForms, seedServiceProviders };
