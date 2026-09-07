// Make sure stored image bytes are something every browser can render.
// iPhones often produce HEIC/HEIF, which Chrome/Firefox can't display — so we
// transcode those to JPEG. Everything else is passed through untouched.

// HEIC/HEIF files are ISO-BMFF: bytes 4..8 are 'ftyp', and the brand that
// follows is one of heic/heix/hevc/mif1/msf1/heif...
function isHeic(buffer, contentType) {
  if (/hei[cf]|hevc/i.test(contentType || '')) return true;
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return /heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1|heif/.test(brand);
}

// Returns { buffer, contentType, converted }. Never throws — on a conversion
// failure it returns the original bytes so we don't lose the upload.
async function toRenderable(buffer, contentType) {
  if (!isHeic(buffer, contentType)) return { buffer, contentType, converted: false };
  try {
    const convert = require('heic-convert');
    const out = await convert({ buffer, format: 'JPEG', quality: 0.85 });
    return { buffer: Buffer.from(out), contentType: 'image/jpeg', converted: true };
  } catch (e) {
    return { buffer, contentType, converted: false, error: e.message };
  }
}

module.exports = { isHeic, toRenderable };
