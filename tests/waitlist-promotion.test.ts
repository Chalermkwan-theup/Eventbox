/**
 * Waitlist promotion: a sold-out tier frees up a seat (hold expires) ->
 * expire_stale_orders() re-offers it to the earliest queued entry (FIFO,
 * ordered by created_at) via promote_waitlist().
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
import { cleanupOrg, cleanupUsers, createTestUsers, getTierInventory, seedEventWithTier } from "./helpers/seed";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 60_000; // 1 minute slack around "+24h" for test execution time

describe.skipIf(!hasDatabaseUrl())("waitlist promotion (promote_waitlist / expire_stale_orders)", () => {
  // See oversell-concurrency.test.ts for why this must be hasDatabaseUrl()-guarded
  // rather than an unconditional getPool() call at the top of describe().
  const pool = hasDatabaseUrl() ? getPool() : (undefined as unknown as ReturnType<typeof getPool>);
  const createdOrgIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await assertMigrationsApplied(pool);
  });

  afterAll(async () => {
    for (const orgId of createdOrgIds) await cleanupOrg(pool, orgId);
    await cleanupUsers(pool, createdUserIds);
    await closePool();
  }, 60_000);

  it("offers the freed seat to the earliest queued entry (FIFO) once the original hold expires", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 1, priceSatang: 30000 });
    createdOrgIds.push(orgId);
    const [originalBuyer, firstInLine, secondInLine] = await createTestUsers(pool, "wl-fifo", 3);
    createdUserIds.push(originalBuyer, firstInLine, secondInLine);

    const reservation = await callAsUser<ReserveTicketsRow>(originalBuyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    expect(reservation.error).toBeNull();
    const heldOrderId = reservation.data!.order_id;
    expect((await getTierInventory(pool, tierId)).reserved).toBe(1); // tier is now full

    // Both join the waitlist, with an explicit, deterministic ordering —
    // relying on `now()` alone across two inserts risks same-millisecond ties.
    await pool.query(
      `insert into waitlist_entry (event_id, tier_id, user_id, status, created_at)
       values ($1, $2, $3, 'queued', now() - interval '2 minutes')`,
      [eventId, tierId, firstInLine]
    );
    await pool.query(
      `insert into waitlist_entry (event_id, tier_id, user_id, status, created_at)
       values ($1, $2, $3, 'queued', now() - interval '1 minute')`,
      [eventId, tierId, secondInLine]
    );

    await pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [heldOrderId]);
    await pool.query(`select expire_stale_orders()`);

    const { rows: entries } = await pool.query(
      `select user_id, status, offered_order_id, offer_expires_at
       from waitlist_entry where tier_id = $1 order by created_at`,
      [tierId]
    );

    const firstEntry = entries.find((e) => e.user_id === firstInLine);
    const secondEntry = entries.find((e) => e.user_id === secondInLine);

    expect(firstEntry?.status).toBe("offered");
    expect(firstEntry?.offered_order_id).not.toBeNull();
    expect(secondEntry?.status).toBe("queued"); // still waiting — FIFO respected, only one seat freed up

    const offerExpiresMs = new Date(firstEntry!.offer_expires_at!).getTime();
    expect(Math.abs(offerExpiresMs - (Date.now() + ONE_DAY_MS))).toBeLessThan(TOLERANCE_MS);

    const { rows: offeredOrderRows } = await pool.query(
      `select status, user_id from orders where id = $1`,
      [firstEntry!.offered_order_id]
    );
    expect(offeredOrderRows[0].status).toBe("pending_payment");
    expect(offeredOrderRows[0].user_id).toBe(firstInLine);

    // the seat is now held by firstInLine instead of the original buyer
    expect((await getTierInventory(pool, tierId)).reserved).toBe(1);
  }, 30_000);

  it("promote_waitlist() is a no-op when the tier still has zero free capacity", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 1, priceSatang: 30000 });
    createdOrgIds.push(orgId);
    const [buyer, waiter] = await createTestUsers(pool, "wl-full", 2);
    createdUserIds.push(buyer, waiter);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    expect(reservation.error).toBeNull();

    await pool.query(
      `insert into waitlist_entry (event_id, tier_id, user_id, status) values ($1, $2, $3, 'queued')`,
      [eventId, tierId, waiter]
    );

    await pool.query(`select promote_waitlist($1::uuid)`, [tierId]);

    const { rows } = await pool.query(`select status from waitlist_entry where tier_id = $1 and user_id = $2`, [
      tierId,
      waiter,
    ]);
    expect(rows[0].status).toBe("queued"); // untouched — no capacity was actually freed
    expect((await getTierInventory(pool, tierId)).reserved).toBe(1);
  }, 30_000);
});
