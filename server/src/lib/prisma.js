const { PrismaClient } = require('@prisma/client');

// Single shared client across the app.
const prisma = global.__staysyncPrisma || new PrismaClient();
if (!global.__staysyncPrisma) global.__staysyncPrisma = prisma;

module.exports = prisma;
