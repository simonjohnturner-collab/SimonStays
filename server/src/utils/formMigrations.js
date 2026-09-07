const prisma = require('../lib/prisma');

// Sections whose photo uploads are mandatory — a checkout must document each of
// these rooms. Photos in any OTHER section (Guests, purchases, breakage, general)
// are optional so they never block a cleaner's submission.
const ROOM_RE = /bathroom|bedroom|kitchen|patio|living|lounge|dining/i;
const GUEST_RE = /guest/i;
const GUEST_PHOTO_ID = 'guest_left_photos';
const guestPhotoField = () => ({ id: GUEST_PHOTO_ID, label: 'Photos of anything the guest left behind', type: 'photos', required: false });

// Idempotently normalise every clean template:
//   • photos are REQUIRED only inside room sections, optional everywhere else
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
    let inRoom = false, inGuest = false, guestAdded = hasGuestPhoto, dirty = false;
    const out = [];

    for (const f of fields) {
      if (f && f.type === 'section') {
        if (inGuest && !guestAdded) { out.push(guestPhotoField()); guestAdded = true; dirty = true; }
        inRoom = ROOM_RE.test(f.label || '');
        inGuest = GUEST_RE.test(f.label || '');
        out.push(f);
        continue;
      }
      if (f && f.type === 'photos' && !!f.required !== inRoom) { out.push({ ...f, required: inRoom }); dirty = true; continue; }
      out.push(f);
    }
    // Guests may be the last section in the form.
    if (inGuest && !guestAdded) { out.push(guestPhotoField()); dirty = true; }

    if (dirty) { await prisma.formTemplate.update({ where: { id: t.id }, data: { fields: out } }); changed++; }
  }
  if (changed) console.log(`[forms] normalised ${changed} clean template(s)`);
  return changed;
}

module.exports = { normaliseCleanForms };
