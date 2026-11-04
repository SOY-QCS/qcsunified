# QCS Unified

The QCS Ghana delivery platform: Express, e-commerce/bulk, inter-city and fulfilment in one system.
The full product brief and rules are in [`CLAUDE.md`](./CLAUDE.md).

## What's in the box

```
apps/
  client-mobile    Expo app — customers and vendors
  rider-mobile     Expo app — riders, plus Hub mode for hub handlers
  ops-dashboard    Next.js — operations, CRM, finance (QCS orange #df6518)
  client-portal    Next.js — vendors on a laptop: bulk upload, statements
  website          Next.js — public site, tracking, rate calculator
packages/
  config           shared constants + TypeScript settings
  types            shared types and validation (mirrors the database enums)
  pricing          the ONLY place prices are calculated
  api-client       one Supabase client for every app
  ui               colours and spacing shared by web and mobile
supabase/
  migrations/      the database, built step by step
  seed.sql         sample cities, zones, hubs and prices
  tests/           database tests (roles, money, status rules)
```

## Phase 1 — Foundations

### First-time setup (on your computer)
1. Install [Node.js 22](https://nodejs.org), then `corepack enable` (gives you pnpm).
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it — local Supabase runs inside it.
3. In this folder: `pnpm install`

### Run the database locally
```bash
pnpm db:start     # starts Supabase in Docker, applies migrations + seed data
pnpm db:test      # runs the database tests (81 checks)
pnpm db:reset     # wipe and rebuild the local database from migrations + seed
pnpm db:stop
```
`db:start` prints a **Studio URL** (a web page to browse the tables) and the local API keys.

### Run the code checks
```bash
pnpm test         # pricing engine + type tests
pnpm typecheck    # TypeScript across all apps
pnpm build        # builds the three web apps
```

### Run an app
```bash
pnpm --filter @qcs/ops-dashboard dev     # http://localhost:3000
pnpm --filter @qcs/rider-mobile dev      # scan the QR code with Expo Go
```
The apps are placeholders in Phase 1; screens arrive in later phases.

### Push the database to your Supabase cloud project
```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies migrations (NOT seed.sql)
```
The seed file is sample data for local testing. Real zones and prices are set in the Ops dashboard.

### Notes
- Sample zones are rough rectangles and sample prices are placeholders — redraw and re-price before launch.
- Database tests can also run on plain Postgres + PostGIS without Docker:
  `PLAIN_PG=1 DB_URL=postgresql://postgres@localhost/postgres pnpm db:test`
