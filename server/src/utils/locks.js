// Smart-lock guest-code provisioning for confirmed bookings.
//
// Simon uses RemoteLock and Yale. RemoteLock has a public API for time-bound
// guest PINs; Yale's direct API is partner-gated. The clean path for BOTH is a
// unified provider such as Seam (getseam.com), which wraps RemoteLock + Yale/
// August behind one API — set LOCK_PROVIDER + credentials and implement below.
//
// Called after a booking is confirmed (paid). It must NEVER throw in a way that
// blocks confirmation — a lock hiccup shouldn't fail a paid booking.
//
// When ready: create a PIN valid booking.checkIn → booking.checkOut on the unit's
// lock and return the code string (also worth storing it on the booking).

async function issueGuestCode(/* booking, unit */) {
  if (!process.env.LOCK_PROVIDER) return null; // not configured yet
  // TODO(locks): call the provider (e.g. Seam) to create a time-bound guest code
  // for this unit's device and return it.
  return null;
}

module.exports = { issueGuestCode };
