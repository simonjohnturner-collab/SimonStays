/**
 * Channel import + availability.
 *  - syncUnit(unitId): pull every channel connection's iCal into the unit's
 *    bookings (idempotent upsert by externalUid; removes cancelled ones).
 *  - checkAvailability(...): does a date range clash with any confirmed booking?
 */
const prisma = require('../lib/prisma');
const { parseFeed, isGenericTitle, dateOnly, overlaps } = require('./ical');

const SOURCE_FOR = { airbnb: 'airbnb', booking: 'booking', lekkeslaap: 'lekkeslaap', other: 'import', manual: 'manual' };

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Import all channel calendars for one unit. Returns a summary. */
async function syncUnit(unitId) {
  const channels = await prisma.channelConnection.findMany({
    where: { unitId, importUrl: { not: null } },
  });
  const summary = { unitId, channels: channels.length, added: 0, updated: 0, removed: 0, failed: 0 };

  for (const ch of channels) {
    const source = SOURCE_FOR[ch.type] || 'import';
    let events;
    try {
      events = parseFeed(await fetchText(ch.importUrl));
    } catch (e) {
      summary.failed++;
      await prisma.channelConnection.update({
        where: { id: ch.id },
        data: { lastStatus: `error: ${e.message}`.slice(0, 200), lastSyncedAt: new Date() },
      });
      await prisma.syncLog.create({ data: { unitId, channelType: ch.type, ok: false, message: e.message } });
      continue;
    }

    const seen = new Set();
    let added = 0, updated = 0;
    for (const ev of events) {
      const uid = ev.uid || `${ch.type}|${ev.start.toISOString()}|${ev.end.toISOString()}`;
      seen.add(uid);
      const guestName = isGenericTitle(ev.summary) ? channelLabel(ch.type) : ev.summary;

      const existing = await prisma.booking.findUnique({
        where: { unitId_externalUid: { unitId, externalUid: uid } },
      });
      if (existing) {
        await prisma.booking.update({
          where: { id: existing.id },
          data: {
            checkIn: ev.start, checkOut: ev.end,
            // keep a hand-typed name; only fill placeholders
            guestName: isPlaceholder(existing.guestName) ? guestName : existing.guestName,
            comments: ev.resCode ? mergeResCode(existing.comments, ev.resCode) : existing.comments,
            status: 'confirmed',
          },
        });
        updated++;
      } else {
        await prisma.booking.create({
          data: {
            unitId, source, channelType: ch.type, status: 'confirmed',
            guestName, checkIn: ev.start, checkOut: ev.end, paid: true,
            externalUid: uid, comments: ev.resCode ? `ResCode: ${ev.resCode}` : null,
          },
        });
        added++;
      }
    }

    // Remove this channel's bookings that vanished from the feed (cancellations).
    const stale = await prisma.booking.findMany({
      where: { unitId, source, externalUid: { not: null } },
      select: { id: true, externalUid: true },
    });
    const toRemove = stale.filter((b) => !seen.has(b.externalUid)).map((b) => b.id);
    if (toRemove.length) await prisma.booking.deleteMany({ where: { id: { in: toRemove } } });

    summary.added += added; summary.updated += updated; summary.removed += toRemove.length;
    await prisma.channelConnection.update({
      where: { id: ch.id },
      data: { lastStatus: `ok: +${added} ~${updated} -${toRemove.length}`, lastSyncedAt: new Date() },
    });
    await prisma.syncLog.create({
      data: { unitId, channelType: ch.type, ok: true, added, updated, removed: toRemove.length },
    });
  }
  return summary;
}

/** Sync every unit that has at least one importable channel. */
async function syncAll() {
  const units = await prisma.unit.findMany({
    where: { channels: { some: { importUrl: { not: null } } } },
    select: { id: true },
  });
  const results = [];
  for (const u of units) {
    try { results.push(await syncUnit(u.id)); }
    catch (e) { results.push({ unitId: u.id, error: e.message }); }
  }
  return results;
}

/**
 * Does [checkIn, checkOut) clash with any confirmed booking on the unit?
 * Returns { available, conflicts:[{id,guestName,source,checkIn,checkOut}] }.
 */
async function checkAvailability(unitId, checkIn, checkOut, excludeBookingId) {
  const inD = dateOnly(checkIn), outD = dateOnly(checkOut);
  if (!(outD.getTime() > inD.getTime())) {
    return { available: false, conflicts: [], error: 'check-out must be after check-in' };
  }
  // Pull candidates that could overlap, then apply half-open overlap precisely.
  const candidates = await prisma.booking.findMany({
    where: {
      unitId, status: 'confirmed',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      checkIn: { lt: outD }, checkOut: { gt: inD },
    },
  });
  const conflicts = candidates
    .filter((b) => overlaps(inD, outD, b.checkIn, b.checkOut))
    .map((b) => ({ id: b.id, guestName: b.guestName, source: b.source, checkIn: b.checkIn, checkOut: b.checkOut }));
  return { available: conflicts.length === 0, conflicts };
}

function channelLabel(type) {
  return ({ airbnb: 'Airbnb', booking: 'Booking.com', lekkeslaap: 'LekkeSlaap', other: 'External' })[type] || 'External';
}
function isPlaceholder(name) {
  const t = (name || '').trim().toLowerCase();
  return t === '' || ['airbnb', 'booking.com', 'lekkeslaap', 'external', 'reserved'].indexOf(t) !== -1;
}
function mergeResCode(comments, code) {
  const s = comments || '';
  if (s.indexOf(code) !== -1) return s;
  if (/ResCode:\s*\S+/.test(s)) return s.replace(/ResCode:\s*\S+/, `ResCode: ${code}`);
  return (s ? `${s} | ` : '') + `ResCode: ${code}`;
}

module.exports = { syncUnit, syncAll, checkAvailability };
