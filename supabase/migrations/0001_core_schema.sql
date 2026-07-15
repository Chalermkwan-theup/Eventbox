-- 0001_core_schema.sql
-- Event Ticketing — core schema (Phase 2)
-- Money: integer satang (THB minor unit, 1 THB = 100 satang), stored as bigint.
-- Time: timestamptz (UTC) everywhere; convert to Asia/Bangkok in the app layer only.

create extension if not exists pgcrypto;   -- gen_random_uuid() / gen_random_bytes()
create extension if not exists pg_cron;    -- scheduled stale-hold expiry (see 0002)

-- ============================================================================
-- Enums
-- ============================================================================

create type org_role as enum ('owner', 'admin', 'staff');
create type event_status as enum ('draft', 'published', 'cancelled');
create type order_status as enum ('pending_payment', 'paid', 'cancelled', 'expired', 'refunded');
create type ticket_status as enum ('valid', 'checked_in', 'void');
create type waitlist_status as enum ('queued', 'offered', 'claimed', 'converted', 'expired', 'cancelled');
create type discount_type as enum ('percent', 'fixed_satang');

-- ============================================================================
-- Tenancy
-- ============================================================================

create table organization (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table org_member (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organization(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        org_role not null default 'staff',
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index org_member_user_idx on org_member(user_id);

-- ============================================================================
-- Events & inventory
-- ============================================================================

create table event (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organization(id) on delete cascade,
  name          text not null,
  slug          text not null,
  description   text,
  venue         text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        event_status not null default 'draft',
  created_at    timestamptz not null default now(),
  unique (org_id, slug),
  check (ends_at > starts_at)
);

create index event_org_idx on event(org_id);
create index event_status_idx on event(status);

create table ticket_tier (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references event(id) on delete cascade,
  name            text not null,
  price_satang    bigint not null check (price_satang >= 0),
  per_user_limit  int check (per_user_limit is null or per_user_limit > 0),
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);

create index ticket_tier_event_idx on ticket_tier(event_id);

-- One row per tier. All mutations go through reserve_tickets / confirm_order_paid /
-- internal_release_order (SECURITY DEFINER RPCs) — never written to directly by
-- anon/authenticated roles. See 0002 for the RLS policies that enforce this.
create table tier_inventory (
  tier_id     uuid primary key references ticket_tier(id) on delete cascade,
  quota       int not null check (quota >= 0),
  reserved    int not null default 0 check (reserved >= 0),
  sold        int not null default 0 check (sold >= 0),
  check (reserved + sold <= quota)
);

-- ============================================================================
-- Promotions
-- ============================================================================

create table promo_code (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organization(id) on delete cascade,
  code              text not null,
  discount_type     discount_type not null,
  -- percent: 1-100 (integer percent); fixed_satang: satang
  discount_value    bigint not null check (discount_value > 0),
  active            boolean not null default true,
  starts_at         timestamptz,
  ends_at           timestamptz,
  max_redemptions   int check (max_redemptions is null or max_redemptions > 0),
  redeemed_count    int not null default 0 check (redeemed_count >= 0),
  -- caps how many times a single user may redeem this code; null = unlimited.
  -- Enforced against non-released promo_redemption rows in reserve_tickets().
  per_user_limit    int check (per_user_limit is null or per_user_limit > 0),
  created_at        timestamptz not null default now(),
  unique (org_id, code),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- Restricts a promo to specific tiers. No rows = applies to the whole order.
create table promo_code_tier (
  promo_code_id   uuid not null references promo_code(id) on delete cascade,
  tier_id         uuid not null references ticket_tier(id) on delete cascade,
  primary key (promo_code_id, tier_id)
);

-- ============================================================================
-- Orders / tickets
-- ============================================================================

create table orders (
  id                          uuid primary key default gen_random_uuid(),
  event_id                    uuid not null references event(id),
  user_id                     uuid not null references auth.users(id),
  status                      order_status not null default 'pending_payment',
  subtotal_satang             bigint not null check (subtotal_satang >= 0),
  discount_satang             bigint not null default 0 check (discount_satang >= 0),
  total_satang                bigint not null check (total_satang >= 0),
  promo_code_id               uuid references promo_code(id),
  stripe_payment_intent_id    text,
  expires_at                  timestamptz not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index orders_user_idx on orders(user_id);
create index orders_event_idx on orders(event_id);
-- used heavily by expire_stale_orders() / lazy reclaim in reserve_tickets()
create index orders_pending_expiry_idx on orders(status, expires_at) where status = 'pending_payment';
create unique index orders_stripe_intent_idx on orders(stripe_payment_intent_id) where stripe_payment_intent_id is not null;

create table order_item (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  tier_id             uuid not null references ticket_tier(id),
  quantity            int not null check (quantity > 0),
  unit_price_satang   bigint not null check (unit_price_satang >= 0),
  created_at          timestamptz not null default now(),
  unique (order_id, tier_id)
);

create index order_item_order_idx on order_item(order_id);
create index order_item_tier_idx on order_item(tier_id);

create table promo_redemption (
  id                uuid primary key default gen_random_uuid(),
  promo_code_id     uuid not null references promo_code(id),
  order_id          uuid not null references orders(id) unique,
  user_id           uuid not null references auth.users(id),
  discount_satang   bigint not null check (discount_satang >= 0),
  -- set true by internal_release_order() when the owning order is released
  -- (expired/cancelled) so the promo's redeemed_count and this user's
  -- per-redemption slot are freed back up.
  released          boolean not null default false,
  created_at        timestamptz not null default now()
);

create index promo_redemption_promo_idx on promo_redemption(promo_code_id);
-- reserve_tickets() counts a user's active (non-released) redemptions of a code
create index promo_redemption_user_promo_idx on promo_redemption(promo_code_id, user_id) where not released;

create table ticket (
  id                uuid primary key default gen_random_uuid(),
  order_item_id     uuid not null references order_item(id) on delete cascade,
  tier_id           uuid not null references ticket_tier(id),
  event_id          uuid not null references event(id),
  owner_user_id     uuid not null references auth.users(id),
  serial_no         text not null unique,
  qr_secret         bytea not null,
  status            ticket_status not null default 'valid',
  checked_in_at     timestamptz,
  created_at        timestamptz not null default now()
);

create index ticket_owner_idx on ticket(owner_user_id);
create index ticket_event_idx on ticket(event_id);
create index ticket_order_item_idx on ticket(order_item_id);

create table waitlist_entry (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references event(id),
  tier_id             uuid not null references ticket_tier(id),
  user_id             uuid not null references auth.users(id),
  status              waitlist_status not null default 'queued',
  offered_order_id    uuid references orders(id),
  offer_expires_at    timestamptz,
  created_at          timestamptz not null default now()
);

create index waitlist_tier_status_idx on waitlist_entry(tier_id, status);
-- one active "queued" entry per user per tier
create unique index waitlist_unique_queued on waitlist_entry(tier_id, user_id) where (status = 'queued');
