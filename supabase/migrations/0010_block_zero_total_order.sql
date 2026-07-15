-- 0010_block_zero_total_order.sql
-- Security/product DECISION (code review, Phase 2): a free ticket tier, or a
-- promo code that discounts an order down to zero, currently produces an
-- order with total_satang = 0. Neither /pay (blocked: "Order total must be
-- greater than zero to charge") nor confirm_order_paid (never called, since
-- there's nothing for the webhook to confirm) can ever move it out of
-- 'pending_payment' — it just holds inventory until the hold expires. Phase 2
-- does not support zero-total orders at all; block them at the source
-- (reserve_tickets) instead of leaving customers to discover a dead end at
-- checkout.
--
-- This is the exact reserve_tickets() body from
-- 0004_fix_reserve_tickets_ambiguous_status.sql (same `#variable_conflict
-- use_column` fix, same oversell-safe inventory locking/ordering — untouched)
-- with one addition: after v_total is computed and before the orders row is
-- inserted, reject when v_total <= 0.
create or replace function reserve_tickets(
  p_event_id uuid,
  p_items jsonb,
  p_promo_code text default null
)
returns table (
  order_id uuid, status order_status, expires_at timestamptz,
  subtotal_satang bigint, discount_satang bigint, total_satang bigint
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_hold_minutes constant int := 10;
  v_order_id uuid;
  v_expires_at timestamptz;
  v_item record;
  v_tier_ids uuid[];
  v_subtotal bigint := 0;
  v_discount bigint := 0;
  v_total bigint := 0;
  v_promo record;
  v_promo_id uuid;
  v_promo_subtotal bigint := 0;
  v_promo_user_redemptions bigint;
  v_existing_qty bigint;
  v_updated int;
  v_stale_order record;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = '22023';
  end if;

  if not exists (select 1 from event e where e.id = p_event_id and e.status = 'published') then
    raise exception 'EVENT_NOT_ON_SALE' using errcode = '22023';
  end if;

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
    where e.id = p_event_id and pc.code = p_promo_code and pc.active
    for update;

    if not found then raise exception 'PROMO_INVALID' using errcode = '22023'; end if;
    if v_promo.starts_at is not null and now() < v_promo.starts_at then
      raise exception 'PROMO_NOT_STARTED' using errcode = '22023'; end if;
    if v_promo.ends_at is not null and now() > v_promo.ends_at then
      raise exception 'PROMO_EXPIRED' using errcode = '22023'; end if;
    if v_promo.max_redemptions is not null and v_promo.redeemed_count >= v_promo.max_redemptions then
      raise exception 'PROMO_EXHAUSTED' using errcode = '22023'; end if;

    if v_promo.per_user_limit is not null then
      select count(*) into v_promo_user_redemptions
      from promo_redemption
      where promo_code_id = v_promo.id and user_id = v_user_id and not released;
      if v_promo_user_redemptions >= v_promo.per_user_limit then
        raise exception 'PROMO_PER_USER_LIMIT_EXCEEDED' using errcode = '22023'; end if;
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

  -- Phase 2 DECISION: zero-total orders (free tier, or promo discounting the
  -- order down to nothing) are not supported — there is no payment for /pay
  -- or the Stripe webhook to ever confirm, so the order (and the inventory
  -- hold it took) would sit as dead pending_payment weight until it expires.
  -- Reject before any orders/order_item/promo_redemption row is written, so
  -- this is a clean no-op (the promo_code.redeemed_count increment above is
  -- rolled back with the rest of the transaction on exception).
  if v_total <= 0 then
    raise exception 'ZERO_TOTAL_NOT_SUPPORTED' using errcode = '22023';
  end if;

  v_expires_at := now() + make_interval(mins => v_hold_minutes);

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

revoke execute on function reserve_tickets(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function reserve_tickets(uuid, jsonb, text) to authenticated, service_role;
