/**
 * confirm_order_paid() idempotency — this is called by the Stripe webhook
 * (service role, see app/api/webhooks/stripe/route.ts), and Stripe explicitly
 * documents that the same event may be delivered more than once. Both a
 * sequential retry and a genuinely concurrent double-delivery must issue
 * tickets exactly once.
 *
 * Requires DATABASE_URL — see the setup header in
 * tests/oversell-concurrency.test.ts. Skipped (not failed) if unset.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMigrationsApplied, callAsUser, closePool, getPool, hasDatabaseUrl, RESERVE_TICKETS_SQL, type ReserveTicketsRow } from "./helpers/db";
import { cleanupOrg, cleanupUsers, createTestUsers, getTierInventory, seedEventWithTier } from "./helpers/seed";

async function ticketCountForOrder(pool: ReturnType<typeof getPool>, orderId: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as count from ticket
     where order_item_id in (select id from order_item where order_id = $1)`,
    [orderId]
  );
  return rows[0].count;
}

describe.skipIf(!hasDatabaseUrl())("confirm_order_paid — idempotent ticket issuance", () => {
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

  it("issues tickets once and is a safe no-op on a duplicate Stripe delivery (sequential retry)", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 25000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "confirm-seq", 1);
    createdUserIds.push(buyer);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 2 }]),
      null,
    ]);
    expect(reservation.error).toBeNull();
    const orderId = reservation.data!.order_id;
    const intentId = `pi_test_seq_${randomUUID()}`;
    const paidAmount = reservation.data!.total_satang;

    const first = await pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [
      orderId,
      intentId,
      paidAmount,
    ]);
    expect(first.rows[0].status).toBe("paid");
    expect(await ticketCountForOrder(pool, orderId)).toBe(2);

    let invAfterFirst = await getTierInventory(pool, tierId);
    expect(invAfterFirst.sold).toBe(2);
    expect(invAfterFirst.reserved).toBe(0);

    // Simulated Stripe retry: same event, same payment_intent id, delivered again.
    const second = await pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [
      orderId,
      intentId,
      paidAmount,
    ]);
    expect(second.rows[0].status).toBe("paid");
    expect(second.rows[0].order_id).toBe(orderId);

    expect(await ticketCountForOrder(pool, orderId)).toBe(2); // NOT 4 — no duplicate tickets
    const invAfterSecond = await getTierInventory(pool, tierId);
    expect(invAfterSecond.sold).toBe(2);
    expect(invAfterSecond.reserved).toBe(0);
  }, 30_000);

  it("never double-issues tickets when the same webhook delivery races itself concurrently", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 25000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "confirm-concurrent", 1);
    createdUserIds.push(buyer);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 2 }]),
      null,
    ]);
    expect(reservation.error).toBeNull();
    const orderId = reservation.data!.order_id;
    const intentId = `pi_test_concurrent_${randomUUID()}`;
    const paidAmount = reservation.data!.total_satang;

    // Two genuinely concurrent calls (separate pool connections), racing on the
    // `select ... for update` row lock inside confirm_order_paid().
    const [callA, callB] = await Promise.all([
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [orderId, intentId, paidAmount]),
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [orderId, intentId, paidAmount]),
    ]);

    expect(callA.rows[0].status).toBe("paid");
    expect(callB.rows[0].status).toBe("paid");

    expect(await ticketCountForOrder(pool, orderId)).toBe(2); // not 4
    const inventory = await getTierInventory(pool, tierId);
    expect(inventory.sold).toBe(2);
    expect(inventory.reserved).toBe(0);
  }, 30_000);

  it("rejects confirmation with a different payment_intent_id once the order is already paid", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 25000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "confirm-diff-intent", 1);
    createdUserIds.push(buyer);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    const orderId = reservation.data!.order_id;
    const paidAmount = reservation.data!.total_satang;

    await pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [
      orderId,
      "pi_test_original",
      paidAmount,
    ]);

    await expect(
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [
        orderId,
        "pi_test_different",
        paidAmount,
      ])
    ).rejects.toMatchObject({ message: "ALREADY_PAID_DIFFERENT_INTENT" });

    expect(await ticketCountForOrder(pool, orderId)).toBe(1); // still just the one ticket
  }, 30_000);

  it("rejects confirming an order id that was never reserved", async () => {
    const fakeOrderId = randomUUID();
    await expect(
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [fakeOrderId, "pi_test_unknown", 0])
    ).rejects.toMatchObject({ message: "ORDER_NOT_FOUND" });
  });

  it("rejects confirming an order whose hold already expired (webhook must trigger a refund on this path)", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 25000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "confirm-expired", 1);
    createdUserIds.push(buyer);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    const orderId = reservation.data!.order_id;
    const paidAmount = reservation.data!.total_satang;

    await pool.query(`update orders set expires_at = now() - interval '1 minute' where id = $1`, [orderId]);
    await pool.query(`select expire_stale_orders()`);

    await expect(
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [orderId, "pi_test_late", paidAmount])
    ).rejects.toMatchObject({ message: "ORDER_NOT_PENDING" });

    expect(await ticketCountForOrder(pool, orderId)).toBe(0);
  }, 30_000);

  it("rejects confirmation when the amount actually received doesn't match the order total (security M2)", async () => {
    const { orgId, eventId, tierId } = await seedEventWithTier(pool, { quota: 5, priceSatang: 25000 });
    createdOrgIds.push(orgId);
    const [buyer] = await createTestUsers(pool, "confirm-amount-mismatch", 1);
    createdUserIds.push(buyer);

    const reservation = await callAsUser<ReserveTicketsRow>(buyer, RESERVE_TICKETS_SQL, [
      eventId,
      JSON.stringify([{ tier_id: tierId, quantity: 1 }]),
      null,
    ]);
    expect(reservation.error).toBeNull();
    const orderId = reservation.data!.order_id;
    const correctAmount = Number(reservation.data!.total_satang);

    await expect(
      pool.query(`select * from confirm_order_paid($1::uuid, $2, $3::bigint)`, [
        orderId,
        "pi_test_underpaid",
        correctAmount - 1,
      ])
    ).rejects.toMatchObject({ message: "AMOUNT_MISMATCH" });

    // No tickets issued and the order is still pending — the webhook route is
    // responsible for refunding the underpayment, not this RPC.
    expect(await ticketCountForOrder(pool, orderId)).toBe(0);
    const { rows } = await pool.query(`select status from orders where id = $1`, [orderId]);
    expect(rows[0].status).toBe("pending_payment");

    const invAfterMismatch = await getTierInventory(pool, tierId);
    expect(invAfterMismatch.sold).toBe(0);
    expect(invAfterMismatch.reserved).toBe(1);
  }, 30_000);
});
