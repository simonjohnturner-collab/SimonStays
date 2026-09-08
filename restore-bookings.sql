-- Restore 4 past bookings (Vantage 202/304, Median 707) from the Aug-31 snapshot.
-- hostId is derived from each unit-> property so it matches your live account.
-- Idempotent: inserts a booking only if none with the same unit + dates exists.

BEGIN;

INSERT INTO "Booking" ("id", "unitId", "source", "channelType", "status", "guestName", "checkIn", "checkOut", "paid", "cleaner", "comments", "leavingEarly", "externalUid", "createdAt", "updatedAt", "resCode", "earlyCheckIn", "extraMattress", "hairDryer", "lateCheckOut", "amountOwingCents", "hostId", "paymentStatus", "pricingGroupId")
SELECT 'df83c46f-664f-474d-8126-11b8f534bede', '294e51a5-4450-483e-8ccb-cd5361164679', 'airbnb', 'airbnb', 'confirmed', 'Jefferson', '2026-08-29 12:00:00', '2026-09-01 12:00:00', true, 'Lindeka', 'ResCode: HMES5X3BAK', false, '1418fb94e984-2a608d2ac20acd6d3a0953b9178b61e5@airbnb.com', '2026-08-31 08:29:48.376', '2026-08-31 14:30:04.666', 'HMES5X3BAK', false, false, false, false, NULL, (SELECT p."hostId" FROM "Unit" u JOIN "Property" p ON p.id=u."propertyId" WHERE u.id='294e51a5-4450-483e-8ccb-cd5361164679'), 'paid', NULL
WHERE NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId"='294e51a5-4450-483e-8ccb-cd5361164679' AND b."checkIn"='2026-08-29 12:00:00' AND b."checkOut"='2026-09-01 12:00:00');

INSERT INTO "Booking" ("id", "unitId", "source", "channelType", "status", "guestName", "checkIn", "checkOut", "paid", "cleaner", "comments", "leavingEarly", "externalUid", "createdAt", "updatedAt", "resCode", "earlyCheckIn", "extraMattress", "hairDryer", "lateCheckOut", "amountOwingCents", "hostId", "paymentStatus", "pricingGroupId")
SELECT 'e14083e5-b66d-443e-b432-5604f6b9958b', '9a7d3f07-d22f-4b0a-a554-2b95c9aaa393', 'airbnb', 'airbnb', 'confirmed', 'Carol', '2026-08-29 12:00:00', '2026-09-05 12:00:00', true, '', 'ResCode: HMX3NFFRC2', false, '1418fb94e984-9c29f412b6cdbe7b5969c1e79e5af8ba@airbnb.com', '2026-08-31 08:30:51.462', '2026-08-31 14:30:06.638', 'HMX3NFFRC2', false, false, false, false, NULL, (SELECT p."hostId" FROM "Unit" u JOIN "Property" p ON p.id=u."propertyId" WHERE u.id='9a7d3f07-d22f-4b0a-a554-2b95c9aaa393'), 'paid', NULL
WHERE NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId"='9a7d3f07-d22f-4b0a-a554-2b95c9aaa393' AND b."checkIn"='2026-08-29 12:00:00' AND b."checkOut"='2026-09-05 12:00:00');

INSERT INTO "Booking" ("id", "unitId", "source", "channelType", "status", "guestName", "checkIn", "checkOut", "paid", "cleaner", "comments", "leavingEarly", "externalUid", "createdAt", "updatedAt", "resCode", "earlyCheckIn", "extraMattress", "hairDryer", "lateCheckOut", "amountOwingCents", "hostId", "paymentStatus", "pricingGroupId")
SELECT '26aa901e-b2db-495d-a135-dd560e0bffeb', '4f2da1ca-f30f-44ee-874b-a8b7c9e54250', 'manual', NULL, 'confirmed', 'Zain', '2026-08-26 12:00:00', '2026-08-31 12:00:00', true, 'Bertha', '', false, NULL, '2026-08-30 07:17:05.049', '2026-08-31 09:33:07.191', NULL, false, false, false, false, NULL, (SELECT p."hostId" FROM "Unit" u JOIN "Property" p ON p.id=u."propertyId" WHERE u.id='4f2da1ca-f30f-44ee-874b-a8b7c9e54250'), 'paid', NULL
WHERE NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId"='4f2da1ca-f30f-44ee-874b-a8b7c9e54250' AND b."checkIn"='2026-08-26 12:00:00' AND b."checkOut"='2026-08-31 12:00:00');

INSERT INTO "Booking" ("id", "unitId", "source", "channelType", "status", "guestName", "checkIn", "checkOut", "paid", "cleaner", "comments", "leavingEarly", "externalUid", "createdAt", "updatedAt", "resCode", "earlyCheckIn", "extraMattress", "hairDryer", "lateCheckOut", "amountOwingCents", "hostId", "paymentStatus", "pricingGroupId")
SELECT '2b75b864-5bc0-4545-95d4-0802baeaf0f0', '4f2da1ca-f30f-44ee-874b-a8b7c9e54250', 'airbnb', 'airbnb', 'confirmed', 'Zain', '2026-08-29 12:00:00', '2026-08-31 12:00:00', true, 'Bertha', '', false, '7f662ec65913-84e3610edbaec5912a762fe5ff5e3b4d@airbnb.com', '2026-08-31 09:31:20.882', '2026-08-31 14:30:07.559', NULL, false, false, false, false, NULL, (SELECT p."hostId" FROM "Unit" u JOIN "Property" p ON p.id=u."propertyId" WHERE u.id='4f2da1ca-f30f-44ee-874b-a8b7c9e54250'), 'paid', NULL
WHERE NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId"='4f2da1ca-f30f-44ee-874b-a8b7c9e54250' AND b."checkIn"='2026-08-29 12:00:00' AND b."checkOut"='2026-08-31 12:00:00');

COMMIT;
