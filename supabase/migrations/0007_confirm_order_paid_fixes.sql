-- 0007_confirm_order_paid_fixes.sql
-- Two runtime bugs in confirm_order_paid, both found by executing against a real
-- Supabase Postgres (static review could not catch either):
--
--   1. AMBIGUOUS OUT PARAM (42702): RETURNS TABLE declares OUT column `order_id`, which
--      collided with `order_item.order_id` in
--      `select array_agg(...) from order_item where order_id = p_order_id`, failing on
--      every call. Fixed with `#variable_conflict use_column`.
--
--   2. EXTENSIONS SCHEMA (42883): ticket issuance uses gen_random_bytes()/encode() from
--      pgcrypto, which on Supabase live ONLY in the `extensions` schema. The function
--      pinned `search_path = public`, so ticket issuance failed with "function
--      gen_random_bytes(integer) does not exist". Fixed by widening to
--      `search_path = public, extensions`.
--
-- (An earlier fix for bug #1 alone was applied directly to the live DB, ahead of
-- being committed here, and never landed in this repo as its own migration file
-- — this migration is the first and only committed fix for both bugs.)
create or replace function confirm_order_paid(
  p_order_id uuid,
  p_stripe_payment_intent_id text
)
returns table (order_id uuid, status order_status, total_satang bigint)
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_order record;
  v_tier_ids uuid[];
  v_item record;
  v_serial text;
  v_ticket_num int;
  v_attempt int;
  v_max_attempts constant int := 5;
  v_done boolean;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = '22023'; end if;

  if v_order.status = 'paid' then
    if v_order.stripe_payment_intent_id = p_stripe_payment_intent_id then
      return query select v_order.id, v_order.status, v_order.total_satang;
      return;
    end if;
    raise exception 'ALREADY_PAID_DIFFERENT_INTENT' using errcode = '22023';
  end if;

  if v_order.status <> 'pending_payment' then
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
    from order_item where order_id = p_order_id group by tier_id
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

  update waitlist_entry set status = 'converted'
    where offered_order_id = p_order_id and status in ('claimed', 'offered');

  return query select p_order_id, 'paid'::order_status, v_order.total_satang;
end;
$$;

revoke execute on function confirm_order_paid(uuid, text) from public, anon, authenticated;
grant execute on function confirm_order_paid(uuid, text) to service_role;
