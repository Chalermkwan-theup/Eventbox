/**
 * Promo code redemption caps under concurrency.
 *
 * Ticket inventory is intentionally NOT the bottleneck in this file (large
 * quota) — the thing under race here is promo_code.redeemed_count /
 * max_redemptions and promo_code.per_user_limit via the promo_redemption
 * table, both enforced inside reserve_tickets() while holding
 * `select ... for update` on the promo_code row.
 *
 * Requires DATABASE_URL — see the setup header in
 * tests/oversell-concurrency.test.ts. Skipped (not failed) if unset.
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
import {
  cleanupOrg,
  cleanupUsers,
  createTestUsers,
  seedEventWithTier,
  seedPromoCode,
} from "./helpers/seed";
import { runWithConcurrency } from "./helpers/concurrency";

describe.skipIf(!hasDatabaseUrl())("reserve_tickets — promo code quota race", () => {
  // See oversell-concurrency.test.ts for why this must be hasDatabaseUrl()-guarded
  // rather than an unconditional getPool() call at the top of describe().
  const pool = hasDatabaseUrl() ? getPool() : (undefined as unknown as ReturnType<typeof getPool>);

  beforeAll(async () => {
    await assertMigrationsApplied(pool);
  });

  afterAll(async () => {
    await closePool();
  });

  describe("global max_redemptions cap", () => {
    const PROMO_MAX = 10;
    const BUYERS = 30;
    let orgId: string;
    let eventId: string;
    let tierId: string;
    let promoId: string;
    let userIds: string[];

    beforeAll(async () => {
      ({ orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 1000, priceSatang: 10000 }));
      promoId = await seedPromoCode(pool, orgId, {
        code: "RACE10",
        discountType: "percent",
        discountValue: 10,
        maxRedemptions: PROMO_MAX,
      });
      userIds = await createTestUsers(pool, "promo-global", BUYERS);
    }, 60_000);

    afterAll(async () => {
      await cleanupOrg(pool, orgId);
      await cleanupUsers(pool, userIds);
    }, 30_000);

    it(
      `redeems the code exactly ${PROMO_MAX} times across ${BUYERS} concurrent distinct buyers`,
      async () => {
        const results: Array<{ ok: boolean; code?: string }> = new Array(BUYERS);

        await runWithConcurrency(userIds, 20, async (userId, index) => {
          const { error } = await callAsUser<ReserveTicketsRow>(userId, RESERVE_TICKETS_SQL, [
            eventId,
            JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
            "RACE10",
          ]);
          results[index] = error ? { ok: false, code: error.message } : { ok: true };
        });

        const successes = results.filter((r) => r.ok);
        const failures = results.filter((r) => !r.ok);

        expect(successes).toHaveLength(PROMO_MAX);
        expect(failures).toHaveLength(BUYERS - PROMO_MAX);
        expect(failures.every((f) => f.code === "PROMO_EXHAUSTED")).toBe(true);

        const { rows: promoRows } = await pool.query(
          `select redeemed_count from promo_code where id = $1`,
          [promoId]
        );
        expect(promoRows[0].redeemed_count).toBe(PROMO_MAX);

        const { rows: redemptionRows } = await pool.query(
          `select count(*)::int as count from promo_redemption where promo_code_id = $1 and not released`,
          [promoId]
        );
        expect(redemptionRows[0].count).toBe(PROMO_MAX);
      },
      60_000
    );
  });

  describe("per_user_limit", () => {
    let orgId: string;
    let eventId: string;
    let tierId: string;
    let userId: string;

    beforeAll(async () => {
      // per_user_limit left null on the tier itself so only the promo's
      // per-user cap is under test here, not the ticket-tier one.
      ({ orgId, eventId, tierId } = await seedEventWithTier(pool, {
        quota: 1000,
        priceSatang: 10000,
        perUserLimit: null,
      }));
      await seedPromoCode(pool, orgId, {
        code: "ONEPERUSER",
        discountType: "fixed_satang",
        discountValue: 500,
        perUserLimit: 1,
      });
      [userId] = await createTestUsers(pool, "promo-peruser", 1);
    }, 30_000);

    afterAll(async () => {
      await cleanupOrg(pool, orgId);
      await cleanupUsers(pool, [userId]);
    }, 30_000);

    it("lets the same user redeem a per_user_limit=1 promo only once, even racing itself 5-way", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          callAsUser<ReserveTicketsRow>(userId, RESERVE_TICKETS_SQL, [
            eventId,
            JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
            "ONEPERUSER",
          ])
        )
      );

      const successes = attempts.filter((a) => !a.error);
      const failures = attempts.filter((a) => a.error);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(4);
      expect(failures.every((f) => f.error?.message === "PROMO_PER_USER_LIMIT_EXCEEDED")).toBe(true);

      // a failed promo redemption aborts the whole reservation (raise exception
      // happens before the order insert) — the user must have exactly one order.
      const { rows: orderRows } = await pool.query(
        `select count(*)::int as count from orders where event_id = $1 and user_id = $2`,
        [eventId, userId]
      );
      expect(orderRows[0].count).toBe(1);
    }, 30_000);
  });
});
