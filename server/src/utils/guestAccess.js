// Which trips a guest account may see. A booking belongs to whoever holds its email
// address, so an account only counts as that person once it has proved the address
// is theirs: anyone can sign up with someone else's. A friend added to a trip gets
// in through their invite instead, so that needs no proof.
const NOTHING = { id: { in: [] } };

const ownTrips = (acct) => (acct.emailVerifiedAt
  ? { OR: [{ guestAccountId: acct.id }, { guestEmail: { equals: acct.email, mode: 'insensitive' } }] }
  : NOTHING);

const onTrip = (acct) => ({ OR: [ownTrips(acct), { tripGuests: { some: { guestAccountId: acct.id } } }] });

const isBooker = (b, acct) => !!acct.emailVerifiedAt
  && (b.guestAccountId === acct.id || (b.guestEmail || '').toLowerCase() === acct.email.toLowerCase());

module.exports = { ownTrips, onTrip, isBooker };
