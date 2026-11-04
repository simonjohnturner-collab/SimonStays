// The profile picture and copy of ID a guest uploads when creating an account.
const { sniff } = require('./attachments');

// The JSON body limit is 12 MB and base64 adds a third, so two of these still fit.
const MAX_BYTES = 4 * 1024 * 1024;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];
const RULES = {
  photo: { types: IMAGES, fallback: 'profile-picture', missing: 'Please add a profile picture.', wrongType: 'Please use a JPG, PNG or WebP photo for your profile picture.' },
  id: { types: [...IMAGES, 'application/pdf'], fallback: 'id-document', missing: 'Please add a copy of your ID.', wrongType: 'Please upload your ID as a photo or a PDF.' },
};

// Check an uploaded file: { filename, data } with data in base64. Answers the
// fields to store, or { error } with a message for the guest.
function readDocument(kind, file) {
  const rule = RULES[kind];
  const buf = Buffer.from(String((file && file.data) || '').replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) return { error: rule.missing };
  if (buf.length > MAX_BYTES) return { error: 'That file is too big. The limit is 4 MB.' };
  const contentType = sniff(buf);
  if (!rule.types.includes(contentType)) return { error: rule.wrongType };
  const filename = String((file && file.filename) || '').replace(/[^\w .()-]/g, '_').trim().slice(0, 120) || rule.fallback;
  return { kind, data: buf, contentType, filename };
}

module.exports = { readDocument, DOCUMENT_KINDS: Object.keys(RULES) };
