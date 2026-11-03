// Files on a message. For now, that's a guest's proof of payment for an EFT. They
// can hold the guest's bank details, so they're stored privately in the database
// and only the host of the booking can open them.
const prisma = require('../lib/prisma');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROOFS_PER_BOOKING = 10;

// The file's type comes from its first bytes, never from what the browser claims,
// so nothing uploaded can be served back as a web page.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'image/heic'; // iPhone photos
  return null;
}

const cleanName = (name) => String(name || '').replace(/[^\w .()-]/g, '_').trim().slice(0, 120) || 'proof-of-payment';

// Put a guest's proof of payment in the booking's message thread.
async function addProof(booking, { filename, data }) {
  const base64 = String(data || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) return { error: 'empty', status: 400, message: 'Please choose a file.' };
  if (buf.length > MAX_BYTES) return { error: 'too_large', status: 413, message: 'That file is too big. The limit is 8 MB.' };
  const contentType = sniff(buf);
  if (!contentType) return { error: 'bad_type', status: 415, message: 'Please upload a PDF or a photo.' };
  const hostId = booking.hostId || (booking.unit && booking.unit.property.hostId);
  const sent = await prisma.messageAttachment.count({ where: { message: { bookingId: booking.id } } });
  if (sent >= MAX_PROOFS_PER_BOOKING) return { error: 'too_many', status: 429, message: 'This booking already has several files. Please message your host.' };
  const name = cleanName(filename);
  const message = await prisma.message.create({
    data: {
      hostId, bookingId: booking.id, sender: 'guest', bookerOnly: true,
      body: `📎 Proof of payment${booking.ref ? ` for ${booking.ref}` : ''}: ${name}`,
      attachments: { create: { data: buf, contentType, filename: name } },
    },
  });
  return { ok: true, message };
}

module.exports = { addProof, sniff, MAX_BYTES };
