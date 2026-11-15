// The host's bank details for an EFT. Only given to a guest who has chosen to
// pay by EFT (a booking, an invoice, or guestbook extras), never on the public
// listings. Null when the host hasn't filled in their bank details.
const prisma = require('../lib/prisma');

async function eftFor(hostId) {
  const h = await prisma.host.findUnique({ where: { id: hostId }, select: { name: true } });
  const biller = await prisma.billerProfile.findUnique({ where: { hostId }, select: { companyName: true, bankName: true, accountNumber: true, branch: true } });
  if (!biller || !(biller.bankName || biller.accountNumber)) return null;
  return {
    accountName: biller.companyName || (h && h.name) || null,
    bankName: biller.bankName || null, accountNumber: biller.accountNumber || null, branch: biller.branch || null,
  };
}

module.exports = { eftFor };
