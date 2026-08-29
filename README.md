# SimonStays

(Internal project/folder name: StaySync.) A **multi-tenant property calendar + channel manager**. Any host signs up, adds
their properties and units, keeps one master calendar per unit, and syncs it
two-way with OTA channels (Airbnb, Booking.com, LekkeSlaap) over iCal.

Working name — rename freely.

## Why this shape

The integration ceiling is set by the channels, not by us:

- **Airbnb** — no self-serve API; iCal import/export only (block/unblock dates).
  The real API is a hard-to-get partner program.
- **Booking.com** — has a Connectivity API but requires becoming a certified
  Connectivity Partner; until then, iCal.
- **LekkeSlaap** — typically synced via the NightsBridge booking engine.

So the common denominator that works for everyone **today** is **two-way iCal**,
with StaySync as the *master calendar*: it imports each channel's feed and
exports one merged blocking feed each channel re-pulls. Channels sit behind a
pluggable adapter, so an official **API adapter** can replace the iCal one per
channel as you qualify — without rebuilding.

> Honest limit: iCal re-sync is periodic (hours), so a booking made directly on a
> channel in the gap before it pulls our block can still double-book. Real-time
> APIs are the only full fix, and those need the partner programs above.

## Status — Milestone 1 (core engine + tenancy) ✅ backend

Built and green (`npm run smoke`, 23 checks): host auth + tenant isolation,
properties/units CRUD, manual bookings with **live conflict prevention**
(back-to-back allowed), the **public export feed** (token-protected), and
**channel import** (idempotent upsert, cancellations removed) on a 30-min
scheduler. Next: the React calendar UI, then overlays (cleaner / floating /
unpaid), then per-channel API adapters, then billing.

## Stack

Node/Express + Prisma + PostgreSQL (same stack as the Eve project). React web
UI to follow. Deploys on Render.

## Run the backend (local)

```bash
cd server
cp .env.example .env          # adjust DATABASE_URL / JWT_SECRET if needed
npm install
npx prisma db push            # creates the `staysync` DB + schema
npm run smoke                  # end-to-end test (boots on an ephemeral port)
npm run dev                    # start API on :4000 (nodemon)
```

Requires a local PostgreSQL (defaults to `postgres:postgres@localhost:5432`).

## API surface (M1)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` · `/auth/login` | returns `{ token }` |
| GET | `/auth/me` | current host |
| GET/POST | `/properties` | host's properties (+units) |
| PATCH/DELETE | `/properties/:id` | |
| POST | `/units` | `{ propertyId, name, capacity }` |
| GET/PATCH/DELETE | `/units/:id` | GET returns `feedUrl` |
| GET | `/units/:id/bookings?from=&to=` | |
| POST | `/units/:id/sync` | pull this unit's channels now |
| GET | `/units/:unitId/channels` · POST | connect a channel (`type`,`importUrl`) |
| DELETE | `/channels/:channelId` | |
| GET | `/units/:unitId/availability?checkIn=&checkOut=` | live (syncs first) |
| POST | `/units/:unitId/bookings` | manual; `409` on clash unless `override` |
| PATCH/DELETE | `/bookings/:id` | |
| GET | `/feed/:unitId.ics?token=&exclude=airbnb` | **public** export feed |

## Data model

`Host → Property → Unit`; each `Unit` has `Booking[]` (source: manual/airbnb/
booking/lekkeslaap; status: confirmed/floating/cancelled) and
`ChannelConnection[]` (per-channel iCal import URL). `SyncLog` records each pull.
See `server/prisma/schema.prisma`.
