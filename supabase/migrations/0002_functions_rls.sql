-- 0002_functions_rls.sql
-- Event Ticketing — RPCs, RLS policies, and the pg_cron hold-expiry job (Phase 2)
--
-- Concurrency model:
--   * Every function that mutates tier_inventory locks the affected rows with
--     `... for update` in ascending tier_id order. All call sites (reserve_tickets,
--     internal_release_order, confirm_order_paid, promote_waitlist) follow this same
--     ordering, which prevents lock-cycle deadlocks between concurrent transactions.
--     The API layer additionally retries once on SQLSTATE 40P01 as defense in depth.
--   * Writes to tier_inventory / orders / order_item / ticket / promo_code.redeemed_count
--     never happen through direct table grants — RLS is enabled with no write policies
--     on those tables, and all mutation happens inside SECURITY DEFINER functions owned
--     by the migration role, which (as table owner) bypasses RLS.

-- ============================================================================
-- Helpers
-- ============================================================================

create or replace function is_org_member(p_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from org_member
    where org_id = p_org_id and user_id = auth.uid()
  );
$$;

create or replace function is_org_admin(p_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from org_member
    where org_id = p_org_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

-- ============================================================================
-- reserve_tickets — atomic hold + promo application
--   p_items shape: [{"tier_id": "<uuid>", "quantity": 2}, ...]
-- ============================================================================

create or replace function reserve_tickets(
  p_event_id uuid,
  p_items jsonb,
  p_promo_code text default null
)
returns table (
  order_id          uuid,
  status            order_status,
  expires_at        timestamptz,
  subtotal_satang   bigint,
  discount_satang   bigint,
  total_satang      bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id                   uuid := auth.uid();
  v_hold_minutes      constant int := 10;
  v_order_id                   uuid;
  v_expires_at                 timestamptz;
  v_item                       record;
  v_tier_ids                   uuid[];
  v_subtotal                   bigint := 0;
  v_discount                   bigint := 0;
  v_total                      bigint := 0;
  v_promo                      record;
  v_promo_id                   uuid;
  v_promo_subtotal             bigint := 0;
  v_promo_user_redemptions     bigint;
  v_existing_qty                bigint;
  v_updated                    int;
  v_stale_order                record;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = '22023';
  end if;

  if not exists (select 1 from event where id = p_event_id and status = 'published') then
    raise exception 'EVENT_NOT_ON_SALE' using errcode = '22023';
  end if;

  -- distinct tier ids, sorted (deterministic lock order) + reject duplicate tier entries
  select array_agg(distinct (elem ->> 'tier_id')::uuid order by (elem ->> 'tier_id')::uuid)
    into v_tier_ids
  from jsonb_array_elements(p_items) elem;

  if v_tier_ids is null or array_length(v_tier_ids, 1) <> jsonb_array_length(p_items) then
    raise exception 'DUPLICATE_TIER_IN_REQUEST' using errcode = '22023';
  end if;

  for v_item in
    select (elem ->> 'tier_id')::uuid as tier_id, (elem ->> 'quantity')::int as quantity
    from jsonb_array_elements(p_items) elem
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'INVALID_QUANTITY' using errcode = '22023';
    end if;
  end loop;

  -- lazy reclaim: release any pending orders on these tiers whose hold already lapsed,
  -- so quota checks below see accurate numbers even if pg_cron hasn't ticked yet
  for v_stale_order in
    select distinct o.id
    from orders o
    join order_item oi on oi.order_id = o.id
    where oi.tier_id = any(v_tier_ids)
      and o.status = 'pending_payment'
      and o.expires_at < now()
  loop
    perform internal_release_order(v_stale_order.id, 'expired');
  end loop;

  -- lock inventory rows in ascending tier_id order (deadlock-safe across concurrent calls)
  perform 1 from tier_inventory where tier_id = any(v_tier_ids) order by tier_id for update;

  if exists (
    select 1
    from unnest(v_tier_ids) t(tier_id)
    left join ticket_tier tt on tt.id = t.tier_id and tt.event_id = p_event_id
    where tt.id is null
  ) then
    raise exception 'INVALID_TIER_FOR_EVENT' using errcode = '22023';
  end if;

  select coalesce(sum(tt.price_satang * i.quantity), 0)
    into v_subtotal
  from jsonb_to_recordset(p_items) as i(tier_id uuid, quantity int)
  join ticket_tier tt on tt.id = i.tier_id;

  if p_promo_code is not null then
    select pc.* into v_promo
    from promo_code pc
    join event e on e.org_id = pc.org_id
    where e.id = p_event_id
      and pc.code = p_promo_code
      and pc.active
    for update;

    if not found then
      raise exception 'PROMO_INVALID' using errcode = '22023';
    end if;

    if v_promo.starts_at is not null and now() < v_promo.starts_at then
      raise exception 'PROMO_NOT_STARTED' using errcode = '22023';
    end if;
    if v_promo.ends_at is not null and now() > v_promo.ends_at then
      raise exception 'PROMO_EXPIRED' using errcode = '22023';
    end if;
    if v_promo.max_redemptions is not null and v_promo.redeemed_count >= v_promo.max_redemptions then
      raise exception 'PROMO_EXHAUSTED' using errcode = '22023';
    end if;

    if v_promo.per_user_limit is not null then
      select count(*) into v_promo_user_redemptions
      from promo_redemption
      where promo_code_id = v_promo.id
        and user_id = v_user_id
        and not released;

      if v_promo_user_redemptions >= v_promo.per_user_limit then
        raise exception 'PROMO_PER_USER_LIMIT_EXCEEDED' using errcode = '22023';
      end if;
    end if;

    if exists (select 1 from promo_code_tier where promo_code_id = v_promo.id) then
      select coalesce(sum(tt.price_satang * i.quantity), 0)
        into v_promo_subtotal
      from jsonb_to_recordset(p_items) as i(tier_id uuid, quantity int)
      join ticket_tier tt on tt.id = i.tier_id
      where exists (
        select 1 from promo_code_tier pct
        where pct.promo_code_id = v_promo.id and pct.tier_id = i.tier_id
      );
    else
      v_promo_subtotal := v_subtotal;
    end if;

    if v_promo.discount_type = 'percent' then
      v_discount := (v_promo_subtotal * v_promo.discount_value) / 100;
    else
      v_discount := least(v_promo.discount_value, v_promo_subtotal);
    end if;

    v_promo_id := v_promo.id;
    update promo_code set redeemed_count = redeemed_count + 1 where id = v_promo_id;
  end if;

  v_total := greatest(v_subtotal - v_discount, 0);
  v_expires_at := now() + make_interval(mins => v_hold_minutes);

  -- FIX (architect note): insert the parent `orders` row BEFORE the order_item loop.
  -- order_item.order_id has a FK to orders — inserting the parent first avoids relying
  -- on a deferrable constraint.
  insert into orders (event_id, user_id, status, subtotal_satang, discount_satang, total_satang, promo_code_id, expires_at)
  values (p_event_id, v_user_id, 'pending_payment', v_subtotal, v_discount, v_total, v_promo_id, v_expires_at)
  returning id into v_order_id;

  if v_promo_id is not null then
    insert into promo_redemption (promo_code_id, order_id, user_id, discount_satang)
    values (v_promo_id, v_order_id, v_user_id, v_discount);
  end if;

  for v_item in
    select (elem ->> 'tier_id')::uuid as tier_id, (elem ->> 'quantity')::int as quantity
    from jsonb_array_elements(p_items) elem
  loop
    select coalesce(sum(oi.quantity), 0) into v_existing_qty
    from order_item oi
    join orders o on o.id = oi.order_id
    where oi.tier_id = v_item.tier_id
      and o.user_id = v_user_id
      and o.status in ('pending_payment', 'paid');

    if exists (
      select 1 from ticket_tier tt
      where tt.id = v_item.tier_id
        and tt.per_user_limit is not null
        and (v_existing_qty + v_item.quantity) > tt.per_user_limit
    ) then
      raise exception 'PER_USER_LIMIT_EXCEEDED' using errcode = '22023';
    end if;

    update tier_inventory
      set reserved = reserved + v_item.quantity
      where tier_id = v_item.tier_id
        and reserved + sold + v_item.quantity <= quota;

    get diagnostics v_updated = row_count;
    if v_updated = 0 then
      raise exception 'SOLD_OUT' using errcode = '22023';
    end if;

    insert into order_item (order_id, tier_id, quantity, unit_price_satang)
    select v_order_id, v_item.tier_id, v_item.quantity, tt.price_satang
    from ticket_tier tt where tt.id = v_item.tier_id;
  end loop;

  return query
  select o.id, o.status, o.expires_at, o.subtotal_satang, o.discount_satang, o.total_satang
  from orders o where o.id = v_order_id;
end;
$$;

-- ============================================================================
-- internal_release_order — idempotent hold release (cron + lazy reclaim)
-- ============================================================================

create or replace function internal_release_order(
  p_order_id uuid,
  p_new_status order_status default 'expired'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order            record;
  v_tier_ids         uuid[];
  v_released_promo   uuid;
begin
  if p_new_status not in ('expired', 'cancelled') then
    raise exception 'INVALID_RELEASE_STATUS' using errcode = '22023';
  end if;

  -- idempotent guard: only ever release an order that is still pending payment.
  -- a second call (e.g. cron overlap, or a race with reserve_tickets' lazy reclaim)
  -- simply finds no matching row and is a silent no-op.
  select * into v_order from orders where id = p_order_id and status = 'pending_payment' for update;
  if not found then
    return;
  end if;

  select array_agg(distinct tier_id order by tier_id) into v_tier_ids
  from order_item where order_id = p_order_id;

  if v_tier_ids is not null then
    perform 1 from tier_inventory where tier_id = any(v_tier_ids) order by tier_id for update;

    update tier_inventory ti
      set reserved = greatest(ti.reserved - oi.qty, 0)
    from (
      select tier_id, sum(quantity) as qty
      from order_item where order_id = p_order_id
      group by tier_id
    ) oi
    where ti.tier_id = oi.tier_id;
  end if;

  -- give back the promo redemption slot (global count + this user's per-user
  -- count) tied to this order, if one was applied. Guarded by `not released`
  -- so a repeated call is a no-op.
  update promo_redemption
    set released = true
    where order_id = p_order_id and not released
    returning promo_code_id into v_released_promo;

  if v_released_promo is not null then
    update promo_code
      set redeemed_count = greatest(redeemed_count - 1, 0)
      where id = v_released_promo;
  end if;

  -- if this order was a waitlist offer the user had started paying for
  -- (attach_payment_intent moved it to 'claimed'), releasing the hold means
  -- the offer itself is gone too — the entry does not go back in the queue.
  update waitlist_entry
    set status = 'expired'
    where offered_order_id = p_order_id and status = 'claimed';

  update orders set status = p_new_status, updated_at = now() where id = p_order_id;
end;
$$;

-- ============================================================================
-- promote_waitlist — offer freed-up capacity to the next queued entry
--   Assumption: each waitlist_entry represents exactly one ticket.
--   Offer window is 24h per design (claim by attaching a payment intent
--   within that window, else expire_stale_orders reclaims it and re-offers).
-- ============================================================================

create or replace function promote_waitlist(p_tier_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer_hours constant int := 24;
  v_entry                  record;
  v_tier                   record;
  v_event_id               uuid;
  v_price                  bigint;
  v_order_id               uuid;
  v_expires_at             timestamptz;
  v_updated                int;
begin
  select event_id, price_satang into v_event_id, v_price
  from ticket_tier where id = p_tier_id;

  if not found then
    return;
  end if;

  -- SKIP LOCKED: don't block on an entry another concurrent promotion is already handling
  select * into v_entry
  from waitlist_entry
  where tier_id = p_tier_id and status = 'queued'
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  select * into v_tier from tier_inventory where tier_id = p_tier_id for update;
  if not found or v_tier.reserved + v_tier.sold + 1 > v_tier.quota then
    return; -- no capacity yet; entry stays 'queued' for the next tick
  end if;

  update tier_inventory
    set reserved = reserved + 1
    where tier_id = p_tier_id and reserved + sold + 1 <= quota;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  v_expires_at := now() + make_interval(hours => v_offer_hours);

  insert into orders (event_id, user_id, status, subtotal_satang, discount_satang, total_satang, expires_at)
  values (v_event_id, v_entry.user_id, 'pending_payment', v_price, 0, v_price, v_expires_at)
  returning id into v_order_id;

  insert into order_item (order_id, tier_id, quantity, unit_price_satang)
  values (v_order_id, p_tier_id, 1, v_price);

  update waitlist_entry
    set status = 'offered', offered_order_id = v_order_id, offer_expires_at = v_expires_at
    where id = v_entry.id;
end;
$$;

-- ============================================================================
-- expire_stale_orders — pg_cron entrypoint (every minute)
-- ============================================================================

create or replace function expire_stale_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  record;
  v_entry  record;
  v_tier   record;
begin
  for v_order in
    select id from orders where status = 'pending_payment' and expires_at < now()
  loop
    perform internal_release_order(v_order.id, 'expired');
  end loop;

  for v_entry in
    select * from waitlist_entry where status = 'offered' and offer_expires_at < now()
  loop
    if v_entry.offered_order_id is not null then
      perform internal_release_order(v_entry.offered_order_id, 'expired');
    end if;
    update waitlist_entry set status = 'expired' where id = v_entry.id;
  end loop;

  -- only re-check tiers that actually have someone queued
  for v_tier in select distinct tier_id from waitlist_entry where status = 'queued'
  loop
    perform promote_waitlist(v_tier.tier_id);
  end loop;
end;
$$;

-- ============================================================================
-- confirm_order_paid — idempotent; called only by the Stripe webhook (service role)
-- ============================================================================

create or replace function confirm_order_paid(
  p_order_id uuid,
  p_stripe_payment_intent_id text
)
returns table (order_id uuid, status order_status, total_satang bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order            record;
  v_tier_ids         uuid[];
  v_item             record;
  v_serial           text;
  v_ticket_num       int;
  v_attempt          int;
  v_max_attempts     constant int := 5;
  v_done             boolean;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = '22023';
  end if;

  -- idempotent: Stripe may deliver the same succeeded event more than once
  if v_order.status = 'paid' then
    if v_order.stripe_payment_intent_id = p_stripe_payment_intent_id then
      return query select v_order.id, v_order.status, v_order.total_satang;
      return;
    end if;
    raise exception 'ALREADY_PAID_DIFFERENT_INTENT' using errcode = '22023';
  end if;

  if v_order.status <> 'pending_payment' then
    -- covers expired/cancelled orders paid after the hold lapsed — caller (webhook)
    -- must trigger a Stripe refund when it sees this error
    raise exception 'ORDER_NOT_PENDING' using errcode = '22023';
  end if;

  select array_agg(distinct tier_id order by tier_id) into v_tier_ids
  from order_item where order_id = p_order_id;

  perform 1 from tier_inventory where tier_id = any(v_tier_ids) order by tier_id for update;

  update tier_inventory ti
    set reserved = greatest(ti.reserved - oi.qty, 0),
        sold = ti.sold + oi.qty
  from (
    select tier_id, sum(quantity) as qty
    from order_item where order_id = p_order_id
    group by tier_id
  ) oi
  where ti.tier_id = oi.tier_id;

  for v_item in
    select oi.id as order_item_id, oi.tier_id, oi.quantity, o.event_id, o.user_id
    from order_item oi
    join orders o on o.id = oi.order_id
    where oi.order_id = p_order_id
  loop
    for v_ticket_num in 1..v_item.quantity loop
      v_done := false;
      for v_attempt in 1..v_max_attempts loop
        begin
          v_serial := upper(encode(gen_random_bytes(6), 'hex'));
          insert into ticket (order_item_id, tier_id, event_id, owner_user_id, serial_no, qr_secret, status)
          values (v_item.order_item_id, v_item.tier_id, v_item.event_id, v_item.user_id, v_serial, gen_random_bytes(32), 'valid');
          v_done := true;
          exit;
        exception when unique_violation then
          -- serial_no collision (astronomically unlikely at 48 bits) — retry with a fresh value
          continue;
        end;
      end loop;
      if not v_done then
        raise exception 'TICKET_SERIAL_GENERATION_FAILED' using errcode = '55000';
      end if;
    end loop;
  end loop;

  update orders
    set status = 'paid', stripe_payment_intent_id = p_stripe_payment_intent_id, updated_at = now()
  where id = p_order_id;

  -- if this order was a waitlist offer, the customer has now actually paid for
  -- it — close out the loop on their waitlist entry. Matches both 'claimed'
  -- (normal path: attach_payment_intent already ran) and 'offered' (defensive
  -- fallback in case payment somehow completed without that step running).
  update waitlist_entry
    set status = 'converted'
    where offered_order_id = p_order_id and status in ('claimed', 'offered');

  return query select p_order_id, 'paid'::order_status, v_order.total_satang;
end;
$$;

-- ============================================================================
-- attach_payment_intent — deviation from the design doc (see hand-off notes):
-- the design didn't specify how order.stripe_payment_intent_id gets set when the
-- PaymentIntent is created (POST /api/checkout/[orderId]/pay runs as the end user,
-- not the webhook/service-role). Rather than use the service-role client on a
-- user-triggered request, this narrow RPC lets the order's own owner attach the
-- intent id while the order is still pending — least-privilege, no RLS bypass needed.
-- ============================================================================

create or replace function attach_payment_intent(p_order_id uuid, p_intent_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update orders
    set stripe_payment_intent_id = p_intent_id, updated_at = now()
  where id = p_order_id
    and user_id = auth.uid()
    and status = 'pending_payment';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'ORDER_NOT_PENDING' using errcode = '22023';
  end if;

  -- if this order is a waitlist offer, starting payment is what "claims" it —
  -- see confirm_order_paid (claimed->converted) and internal_release_order
  -- (claimed->expired if the payment never completes).
  update waitlist_entry
    set status = 'claimed'
    where offered_order_id = p_order_id and status = 'offered';
end;
$$;

-- ============================================================================
-- Row Level Security — deny by default, explicit allow only
-- ============================================================================

alter table organization enable row level security;
alter table org_member enable row level security;
alter table event enable row level security;
alter table ticket_tier enable row level security;
alter table tier_inventory enable row level security;
alter table promo_code enable row level security;
alter table promo_code_tier enable row level security;
alter table orders enable row level security;
alter table order_item enable row level security;
alter table promo_redemption enable row level security;
alter table ticket enable row level security;
alter table waitlist_entry enable row level security;

-- organization: members can see their own org. Org creation/provisioning is an
-- out-of-scope admin/back-office flow for this phase (service role) — no insert policy.
create policy organization_select_member on organization
  for select using (is_org_member(id));

-- org_member: members see their org roster; only owner/admin manage membership.
-- Bootstrapping the very first owner of a brand-new org is out of scope here
-- (done via service role during org provisioning).
create policy org_member_select on org_member
  for select using (is_org_member(org_id));
create policy org_member_write on org_member
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- event: public can browse published events; org staff can see everything in their org.
-- Only org admins/owners can create or edit events.
create policy event_select_public on event
  for select using (status = 'published' or is_org_member(org_id));
create policy event_write_admin on event
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));

-- ticket_tier: same visibility rule as its parent event.
create policy ticket_tier_select on ticket_tier
  for select using (
    exists (
      select 1 from event e
      where e.id = ticket_tier.event_id
        and (e.status = 'published' or is_org_member(e.org_id))
    )
  );
create policy ticket_tier_write_admin on ticket_tier
  for all using (
    exists (select 1 from event e where e.id = ticket_tier.event_id and is_org_admin(e.org_id))
  ) with check (
    exists (select 1 from event e where e.id = ticket_tier.event_id and is_org_admin(e.org_id))
  );

-- tier_inventory: readable (customers need remaining-stock numbers) wherever the
-- tier itself is visible. No write policy at all — reserved/sold only ever change
-- inside reserve_tickets / internal_release_order / confirm_order_paid / promote_waitlist.
create policy tier_inventory_select on tier_inventory
  for select using (
    exists (
      select 1 from ticket_tier tt
      join event e on e.id = tt.event_id
      where tt.id = tier_inventory.tier_id
        and (e.status = 'published' or is_org_member(e.org_id))
    )
  );
-- org admins provision initial quota when a tier is created (not part of the hot path).
create policy tier_inventory_write_admin on tier_inventory
  for insert with check (
    exists (
      select 1 from ticket_tier tt
      join event e on e.id = tt.event_id
      where tt.id = tier_inventory.tier_id and is_org_admin(e.org_id)
    )
  );

-- promo_code / promo_code_tier: never publicly readable (avoid leaking codes) —
-- validity is only ever checked inside reserve_tickets(). Org admins manage them directly.
create policy promo_code_admin on promo_code
  for all using (is_org_admin(org_id)) with check (is_org_admin(org_id));
create policy promo_code_tier_admin on promo_code_tier
  for all using (
    exists (select 1 from promo_code pc where pc.id = promo_code_tier.promo_code_id and is_org_admin(pc.org_id))
  ) with check (
    exists (select 1 from promo_code pc where pc.id = promo_code_tier.promo_code_id and is_org_admin(pc.org_id))
  );

-- orders: the owning customer, or staff of the order's event's org, can read it.
-- No write policy — orders are only ever created/mutated via the RPCs above.
create policy orders_select on orders
  for select using (
    user_id = auth.uid()
    or exists (select 1 from event e where e.id = orders.event_id and is_org_member(e.org_id))
  );

create policy order_item_select on order_item
  for select using (
    exists (
      select 1 from orders o
      where o.id = order_item.order_id
        and (o.user_id = auth.uid() or exists (select 1 from event e where e.id = o.event_id and is_org_member(e.org_id)))
    )
  );

create policy promo_redemption_select on promo_redemption
  for select using (
    user_id = auth.uid()
    or exists (select 1 from promo_code pc where pc.id = promo_redemption.promo_code_id and is_org_member(pc.org_id))
  );

-- ticket: the ticket owner, or staff of its event's org (for future check-in), can read it.
-- No write policy — tickets are only ever issued via confirm_order_paid(); check-in
-- (status -> 'checked_in') is out of scope for this phase and will need its own RPC.
-- RLS is row-level only, so qr_secret is additionally locked down at the column
-- level below (revoke + narrow re-grant, plus a secret-free view for normal reads).
create policy ticket_select on ticket
  for select using (
    owner_user_id = auth.uid()
    or exists (select 1 from event e where e.id = ticket.event_id and is_org_member(e.org_id))
  );

-- waitlist_entry: users manage their own entries directly (no business logic beyond
-- ownership needed for join/cancel); org staff can view entries for their events.
create policy waitlist_select on waitlist_entry
  for select using (
    user_id = auth.uid()
    or exists (select 1 from event e where e.id = waitlist_entry.event_id and is_org_member(e.org_id))
  );
create policy waitlist_insert_owner on waitlist_entry
  for insert with check (user_id = auth.uid());
create policy waitlist_update_owner on waitlist_entry
  for update using (user_id = auth.uid() and status = 'queued') with check (user_id = auth.uid());
create policy waitlist_delete_owner on waitlist_entry
  for delete using (user_id = auth.uid() and status = 'queued');

-- ============================================================================
-- ticket.qr_secret must never be reachable via the API for anon/authenticated —
-- it's the payload that proves a ticket at check-in. RLS is row-level only, so
-- we additionally revoke column access on the base table and expose a
-- secret-free view instead. security_invoker keeps the view subject to the
-- same RLS policy as the underlying table (no privilege escalation).
-- ============================================================================

revoke select on ticket from anon, authenticated;
grant select (id, order_item_id, tier_id, event_id, owner_user_id, serial_no, status, checked_in_at, created_at)
  on ticket to authenticated;

create view ticket_view
  with (security_invoker = true)
  as
  select id, order_item_id, tier_id, event_id, owner_user_id, serial_no, status, checked_in_at, created_at
  from ticket;

grant select on ticket_view to authenticated;

-- ============================================================================
-- Function privileges — RLS only covers tables, so EXECUTE grants are the actual
-- gate for these RPCs. Revoke the default PUBLIC grant, then re-grant narrowly.
-- ============================================================================

revoke execute on function reserve_tickets(uuid, jsonb, text) from public;
revoke execute on function internal_release_order(uuid, order_status) from public;
revoke execute on function promote_waitlist(uuid) from public;
revoke execute on function expire_stale_orders() from public;
revoke execute on function confirm_order_paid(uuid, text) from public;
revoke execute on function attach_payment_intent(uuid, text) from public;
revoke execute on function is_org_member(uuid) from public;
revoke execute on function is_org_admin(uuid) from public;

-- used inside RLS policy expressions evaluated as the querying role
grant execute on function is_org_member(uuid) to anon, authenticated;
grant execute on function is_org_admin(uuid) to anon, authenticated;

-- customer-facing: must be logged in to hold tickets or attach a payment intent
grant execute on function reserve_tickets(uuid, jsonb, text) to authenticated;
grant execute on function attach_payment_intent(uuid, text) to authenticated;

-- internal only: webhook (service role) and pg_cron (runs as the function owner)
grant execute on function confirm_order_paid(uuid, text) to service_role;
grant execute on function internal_release_order(uuid, order_status) to service_role;
grant execute on function promote_waitlist(uuid) to service_role;
grant execute on function expire_stale_orders() to service_role;

-- ============================================================================
-- pg_cron — release expired holds and re-offer freed capacity every minute
-- ============================================================================

select cron.schedule('expire-holds', '* * * * *', $$select expire_stale_orders()$$);
