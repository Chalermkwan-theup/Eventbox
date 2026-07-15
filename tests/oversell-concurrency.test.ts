/**
 * ★ Anti-oversell concurrency — the headline Phase 2 requirement.
 *
 * Fires 500 concurrent "buyers" (each a distinct auth.users row, each its own
 * fresh Postgres connection — no shared transaction, no mocking) at
 * reserve_tickets() against a single 100-seat tier, and asserts:
 *   - exactly 100 succeed
 *   - exactly 400 fail, every one of them with the business error SOLD_OUT
 *     (never a raw CHECK-constraint violation — see the "never a
 *     constraint-violation" assertion below for why that distinction matters)
 *   - tier_inventory.reserved + sold ends at exactly 100 (never more, never less)
 *   - exactly 100 pending_payment orders exist, one per distinct winning user
 *
 * ---------------------------------------------------------------------------
 * SETUP (required — this suite talks to a real Postgres, not a mock):
 *
 *   1. Install the Supabase CLI + Docker Desktop.
 *   2. From the repo root: `supabase start` (first run) or `supabase db reset`
 *      (re-applies supabase/migrations/0001_core_schema.sql and
 *      0002_functions_rls.sql cleanly). Requires pg_cron, which the local
 *      Supabase Postgres image ships with by default.
 *   3. `supabase status` prints the direct Postgres connection info. Default:
 *        DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *      (port 54322 is the direct Postgres port — NOT 54321, which is the
 *      PostgREST/API gateway and won't accept a raw `pg` connection).
 *   4. `npm install` (adds the `pg` devDependency used only by these tests).
 *   5. Export DATABASE_URL in the shell running vitest, e.g.:
 *        # bash
 *        export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
 *        npm run test:run -- tests/oversell-concurrency.test.ts
 *
 * Without DATABASE_URL set, every test in this file is SKIPPED (not failed) —
 * see `describe.skipIf` below — so `npm test` stays green in environments
 * without a database, but nobody can mistake "skipped" for "verified".
 * ---------------------------------------------------------------------------
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertMigrationsApplied,
  callAsUser,
  closePool,
  getPool,
  hasDatabaseUrl,
  RESERVE_TICKETS_SQL,
  type ReserveTicketsRow,
} from "./helpers/db";
import { cleanupOrg, cleanupUsers, createTestUsers, getTierInventory, seedEventWithTier } from "./helpers/seed";
import { runWithConcurrency } from "./helpers/concurrency";

const TICKET_QUOTA = 100;
const BUYER_COUNT = 500;
const MAX_INFLIGHT_CONNECTIONS = Number(process.env.DB_TEST_MAX_CONCURRENCY ?? 40);

describe.skipIf(!hasDatabaseUrl())("reserve_tickets — anti-oversell under 500-way concurrency", () => {
  // Guarded with hasDatabaseUrl() instead of calling getPool() unconditionally:
  // vitest still runs a describe() callback body synchronously during test
  // collection even when describe.skipIf(...) marks it skipped — only the
  // nested it()/beforeAll() bodies are actually skipped. Calling getPool()
  // (which throws when DATABASE_URL is unset) here would crash collection for
  // the whole file instead of cleanly skipping it.
  const pool = hasDatabaseUrl() ? getPool() : (undefined as unknown as ReturnType<typeof getPool>);
  let orgId: string;
  let eventId: string;
  let tierId: string;
  let userIds: string[];

  beforeAll(async () => {
    await assertMigrationsApplied(pool);
    ({ orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: TICKET_QUOTA, priceSatang: 50000 }));
    userIds = await createTestUsers(pool, "oversell", BUYER_COUNT);
  }, 120_000);

  afterAll(async () => {
    if (orgId) await cleanupOrg(pool, orgId);
    if (userIds) await cleanupUsers(pool, userIds);
    await closePool();
  }, 60_000);

  it(
    `sells exactly ${TICKET_QUOTA} tickets to ${BUYER_COUNT} concurrent buyers and rejects the rest with SOLD_OUT`,
    async () => {
      const results: Array<{ ok: boolean; code?: string; sqlstate?: string }> = new Array(BUYER_COUNT);

      await runWithConcurrency(userIds, MAX_INFLIGHT_CONNECTIONS, async (userId, index) => {
        const { error } = await callAsUser<ReserveTicketsRow>(userId, RESERVE_TICKETS_SQL, [
          eventId,
          JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
          null,
        ]);
        results[index] = error
          ? { ok: false, code: error.message, sqlstate: error.sqlstate }
          : { ok: true };
      });

      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);

      expect(successes).toHaveLength(TICKET_QUOTA);
      expect(failures).toHaveLength(BUYER_COUNT - TICKET_QUOTA);

      // Every rejection must be the graceful business error (errcode 22023,
      // raised explicitly in reserve_tickets before any write), never a raw
      // 23514 check_violation. A 23514 here would mean the application-level
      // quota check raced past the guard and only the CHECK constraint (the
      // last line of defense) stopped an actual oversell — that would be a bug.
      const nonSoldOutFailures = failures.filter((f) => f.code !== "SOLD_OUT");
      expect(nonSoldOutFailures).toEqual([]);
      const checkViolations = failures.filter((f) => f.sqlstate === "23514");
      expect(checkViolations).toEqual([]);

      const inventory = await getTierInventory(pool, tierId);
      expect(inventory.sold).toBe(0); // nobody has paid yet in this test — everything is a hold
      expect(inventory.reserved).toBe(TICKET_QUOTA);
      expect(inventory.reserved + inventory.sold).toBe(TICKET_QUOTA);
      expect(inventory.reserved + inventory.sold).toBeLessThanOrEqual(inventory.quota);

      const { rows: pendingCountRows } = await pool.query(
        `select count(*)::int as count from orders where event_id = $1 and status = 'pending_payment'`,
        [eventId]
      );
      expect(pendingCountRows[0].count).toBe(TICKET_QUOTA);

      // one winning ticket per distinct user — confirms no single connection
      // raced its way into a double-award, and no order got created twice.
      const { rows: distinctUserRows } = await pool.query(
        `select count(distinct user_id)::int as count from orders where event_id = $1 and status = 'pending_payment'`,
        [eventId]
      );
      expect(distinctUserRows[0].count).toBe(TICKET_QUOTA);
    },
    180_000
  );
});
