/**
 * Hold expiry + inventory reclaim via expire_stale_orders().
 *
 * Requires DATABASE_URL — see the setup header in
 * tests/oversell-concurrency.test.ts. Skipped (not failed) if unset.
 *
 * Each `it` seeds its own org/event/tier/users so cases never depend on
 * execution order or leak state into each other.
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

describe.skipIf(!hasDatabaseUrl())("expire_stale_orders — hold expiry releases reserved inventory", () => {
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

  it("marks an order expired and returns its reserved quantity to the pool once expires_at has passed", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 20000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "expiry-basic", 1);
    createdUserIds.push(buyer);

    const { data, error } = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 3 }]),
      null,
    ]);
    expect(error).toBeNull();
    const orderId = data!.order_id;

    expect((await getTierInventory(pool, tierId)).reserved).toBe(3);

    // Simulate the 10-minute hold window having lapsed.
    await pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [orderId]);
    await pool.query(`select expire_stale_orders()`);

    const { rows } = await pool.query(`select status from orders where id = $1`, [orderId]);
    expect(rows[0].status).toBe("expired");

    const inventory = await getTierInventory(pool, tierId);
    expect(inventory.reserved).toBe(0);
    expect(inventory.sold).toBe(0);
  }, 30_000);

  it("leaves a hold that has not expired yet untouched", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 20000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "expiry-fresh", 1);
    createdUserIds.push(buyer);

    const { data, error } = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 2 }]),
      null,
    ]);
    expect(error).toBeNull();
    const orderId = data!.order_id;

    await pool.query(`select expire_stale_orders()`);

    const { rows } = await pool.query(`select status from orders where id = $1`, [orderId]);
    expect(rows[0].status).toBe("pending_payment");
    expect((await getTierInventory(pool, tierId)).reserved).toBe(2);
  }, 30_000);

  it("only releases the stale order among a mix of stale and fresh holds on the same tier", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 20000 });
    createdOrgIds.push(orgId);
    const [staleBuyer, freshBuyer] = await createTestUsers(pool, "expiry-mixed", 2);
    createdUserIds.push(staleBuyer, freshBuyer);

    const staleReservation = await callAsUser<ReserveTicketsRow>(staleBuyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 2 }]),
      null,
    ]);
    const freshReservation = await callAsUser<ReserveTicketsRow>(freshBuyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    expect(staleReservation.error).toBeNull();
    expect(freshReservation.error).toBeNull();

    await pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [
      staleReservation.data!.order_id,
    ]);
    await pool.query(`select expire_stale_orders()`);

    const { rows: staleRow } = await pool.query(`select status from orders where id = $1`, [
      staleReservation.data!.order_id,
    ]);
    const { rows: freshRow } = await pool.query(`select status from orders where id = $1`, [
      freshReservation.data!.order_id,
    ]);
    expect(staleRow[0].status).toBe("expired");
    expect(freshRow[0].status).toBe("pending_payment");

    // stale buyer's 2 released, fresh buyer's 1 still held
    expect((await getTierInventory(pool, tierId)).reserved).toBe(1);
  }, 30_000);

  it("is idempotent — calling expire_stale_orders() twice never double-releases or drives reserved negative", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 20000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "expiry-idempotent", 1);
    createdUserIds.push(buyer);

    const { data, error } = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 4 }]),
      null,
    ]);
    expect(error).toBeNull();
    const orderId = data!.order_id;

    await pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [orderId]);

    await pool.query(`select expire_stale_orders()`);
    const afterFirst = await getTierInventory(pool, tierId);
    expect(afterFirst.reserved).toBe(0);

    // second sweep: internal_release_order()'s guard (`where status = 'pending_payment'`)
    // must make this a silent no-op — it must NOT decrement reserved a second time.
    await pool.query(`select expire_stale_orders()`);
    const afterSecond = await getTierInventory(pool, tierId);
    expect(afterSecond.reserved).toBe(0);
    expect(afterSecond.reserved).toBeGreaterThanOrEqual(0); // guards against a `greatest(x,0)`-masked bug going unnoticed

    const { rows } = await pool.query(`select status from orders where id = $1`, [orderId]);
    expect(rows[0].status).toBe("expired");
  }, 30_000);
});
