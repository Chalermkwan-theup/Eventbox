import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * Seeds a minimal org/event/ticket_tier/tier_inventory chain (and, where
 * needed, fake auth.users rows) directly via SQL. This deliberately bypasses
 * the app layer/Supabase Auth signup flow — these are DB-integration tests
 * for the SQL functions themselves, not for user signup.
 *
 * Assumption (flag if it breaks): the target Postgres has the standard
 * Supabase `auth.users` schema already applied (true for any project spun up
 * via `supabase start` / `supabase db reset`), and `id`, `instance_id`, `aud`,
 * `role`, `email`, `encrypted_password`, `email_confirmed_at` cover its
 * required columns. Do NOT insert into `confirmed_at` — on current Supabase
 * images it's a generated column (`least(email_confirmed_at, phone_confirmed_at)`)
 * and an explicit insert into it will error.
 */
export async function createTestUser(pool: Pool, label: string): Promise<string> {
  const id = randomUUID();
  const email = `qa-${label}-${id}@example.test`;
  await pool.query(
    `insert into auth.users
       (id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values
       ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
        crypt('qa-test-password', gen_salt('bf')), now(), now(), now(), '{}'::jsonb, '{}'::jsonb)`,
    [id, email]
  );
  return id;
}

export async function createTestUsers(pool: Pool, label: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await createTestUser(pool, `${label}-${i}`));
  }
  return ids;
}

export interface SeededTier {
  orgId: string;
  eventId: string;
  tierId: string;
}

export interface SeedEventOptions {
  quota: number;
  priceSatang?: number;
  perUserLimit?: number | null;
}

/** Creates one org -> one published event -> one ticket_tier -> its tier_inventory row. */
export async function seedEventWithTier(pool: Pool, opts: SeedEventOptions): Promise<SeededTier> {
  const orgId = randomUUID();
  const eventId = randomUUID();
  const tierId = randomUUID();
  const slugSuffix = orgId.slice(0, 8);

  await pool.query(`insert into organization (id, name, slug) values ($1, $2, $3)`, [
    orgId,
    `QA Test Org ${slugSuffix}`,
    `qa-test-org-${slugSuffix}`,
  ]);

  await pool.query(
    `insert into event (id, org_id, name, slug, starts_at, ends_at, status)
     values ($1, $2, $3, $4, now() + interval '7 days', now() + interval '8 days', 'published')`,
    [eventId, orgId, `QA Test Event ${slugSuffix}`, `qa-test-event-${slugSuffix}`]
  );

  await pool.query(
    `insert into ticket_tier (id, event_id, name, price_satang, per_user_limit, sort_order)
     values ($1, $2, 'General Admission', $3, $4, 0)`,
    [tierId, eventId, opts.priceSatang ?? 10000, opts.perUserLimit ?? null]
  );

  await pool.query(`insert into tier_inventory (tier_id, quota, reserved, sold) values ($1, $2, 0, 0)`, [
    tierId,
    opts.quota,
  ]);

  return { orgId, eventId, tierId };
}

export interface PromoOptions {
  code: string;
  discountType: "percent" | "fixed_satang";
  discountValue: number;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
}

export async function seedPromoCode(pool: Pool, orgId: string, opts: PromoOptions): Promise<string> {
  const promoId = randomUUID();
  await pool.query(
    `insert into promo_code (id, org_id, code, discount_type, discount_value, active, max_redemptions, per_user_limit)
     values ($1, $2, $3, $4, $5, true, $6, $7)`,
    [
      promoId,
      orgId,
      opts.code,
      opts.discountType,
      opts.discountValue,
      opts.maxRedemptions ?? null,
      opts.perUserLimit ?? null,
    ]
  );
  return promoId;
}

export interface TierInventoryRow {
  quota: number;
  reserved: number;
  sold: number;
}

export async function getTierInventory(pool: Pool, tierId: string): Promise<TierInventoryRow> {
  const { rows } = await pool.query(
    `select quota, reserved, sold from tier_inventory where tier_id = $1`,
    [tierId]
  );
  if (rows.length === 0) {
    throw new Error(`tier_inventory row not found for tier_id=${tierId}`);
  }
  return rows[0] as TierInventoryRow;
}

/**
 * Deletes everything scoped to one seeded org, in FK-safe order. Several
 * child tables (orders, ticket, waitlist_entry, promo_redemption) reference
 * event/org/promo_code WITHOUT `on delete cascade` (see 0001_core_schema.sql),
 * so they must be deleted explicitly before their parents — deleting
 * `organization` alone would otherwise fail with a foreign-key violation.
 */
export async function cleanupOrg(pool: Pool, orgId: string): Promise<void> {
  await pool.query(`delete from waitlist_entry where event_id in (select id from event where org_id = $1)`, [
    orgId,
  ]);
  await pool.query(
    `delete from promo_redemption
     where promo_code_id in (select id from promo_code where org_id = $1)
        or order_id in (select id from orders where event_id in (select id from event where org_id = $1))`,
    [orgId]
  );
  // cascades order_item -> ticket automatically (both declared `on delete cascade`)
  await pool.query(`delete from orders where event_id in (select id from event where org_id = $1)`, [orgId]);
  // cascades promo_code_tier
  await pool.query(`delete from promo_code where org_id = $1`, [orgId]);
  // cascades ticket_tier -> tier_inventory
  await pool.query(`delete from event where org_id = $1`, [orgId]);
  await pool.query(`delete from organization where id = $1`, [orgId]);
}

export async function cleanupUsers(pool: Pool, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  // Safe only after cleanupOrg has removed any orders/tickets referencing these
  // users (orders.user_id / ticket.owner_user_id-via-order_item have no cascade
  // from auth.users on the orders side).
  await pool.query(`delete from auth.users where id = any($1::uuid[])`, [userIds]);
}
