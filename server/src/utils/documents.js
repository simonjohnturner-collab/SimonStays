// Shared documents: files a host makes available per property, such as an HOA form.
// Each property's folder has a link only its host and their guests get: property
// ids are public on the booking site, so the link carries a signature as well.
const crypto = require('crypto');

const MAX_BYTES = 8 * 1024 * 1024; // the JSON body limit is 12mb, and base64 adds a third

// Files allowed, by extension, with the bytes that kind of file starts with. No
// HTML or SVG: nothing a browser would run when opened from our own domain.
const PDF = ['25504446'];
const ZIP = ['504b0304'];
const OLE = ['d0cf11e0'];
const FILE_TYPES = {
  pdf: { contentType: 'application/pdf', magic: PDF },
  doc: { contentType: 'application/msword', magic: OLE },
  docx: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP },
  xls: { contentType: 'application/vnd.ms-excel', magic: OLE },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP },
  jpg: { contentType: 'image/jpeg', magic: ['ffd8ff'] },
  jpeg: { contentType: 'image/jpeg', magic: ['ffd8ff'] },
  png: { contentType: 'image/png', magic: ['89504e47'] },
};

function signature(propertyId) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret').update(`documents:${propertyId}`).digest('hex').slice(0, 20);
}

function validSignature(propertyId, sig) {
  const want = Buffer.from(signature(propertyId));
  const got = Buffer.from(String(sig || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function folderLink(propertyId) {
  const base = (process.env.SHOPFRONT_URL || 'https://simonstays.co.za').trim().replace(/\/$/, '');
  return `${base}/documents/${propertyId}/${signature(propertyId)}`;
}

// Check an upload and return { name, contentType, buffer }, or { error } for the host.
function readUpload(filename, dataBase64) {
  const name = String(filename || '').split(/[\\/]/).pop().replace(/[\r\n"]/g, '').trim().slice(0, 150);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const type = FILE_TYPES[ext];
  if (!name || !type) return { error: 'Please upload a PDF, Word or Excel file, or a JPG or PNG image.' };
  const buffer = Buffer.from(String(dataBase64 || '').replace(/^data:[^;]*;base64,/, ''), 'base64');
  if (!buffer.length) return { error: 'That file is empty.' };
  if (buffer.length > MAX_BYTES) return { error: 'That file is too big. The limit is 8 MB.' };
  const start = buffer.subarray(0, 4).toString('hex');
  if (!type.magic.some((m) => start.startsWith(m))) return { error: `That file doesn’t look like a real .${ext} file.` };
  return { name, contentType: type.contentType, buffer };
}

module.exports = { folderLink, validSignature, readUpload };
