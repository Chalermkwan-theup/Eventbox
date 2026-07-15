-- 0009_confirm_amount_check.sql
-- Security M2 — verify the amount actually received by Stripe before issuing
-- tickets. Previously confirm_order_paid() trusted the webhook payload
-- unconditionally: it moved the order to 'paid' and issued tickets purely
-- because *a* payment_intent.succeeded event arrived for that order id, without
-- ever comparing how much money actually landed against orders.total_satang.
-- A manipulated/partial PromptPay charge (or a bug upstream that creates the
-- PaymentIntent with the wrong amount) would still have resulted in full
-- ticket issuance.
--
-- This supersedes the 2-arg version from 0007_confirm_order_paid_fixes.sql.
-- Same body as 0007 (including the #variable_conflict use_column fix for the
-- ambiguous `order_id` OUT param, and `search_path = public, extensions` for
-- gen_random_bytes()/encode()), plus:
--   * a new p_paid_amount bigint parameter
--   * a hard check that it equals orders.total_satang, raising AMOUNT_MISMATCH
--     otherwise, before any inventory/ticket mutation happens
--
-- The old 2-arg signature is dropped outright (not just superseded) so nothing
-- can still call the amount-blind version — `create or replace` does not
-- replace a function with a different argument list, it would just add a second,
-- still-callable overload.
drop function if exists confirm_order_paid(uuid, text);

create or replace function confirm_order_paid(
  p_order_id uuid,
  p_stripe_payment_intent_id text,
  p_paid_amount bigint
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

  -- Amount check happens after the state checks above (so ORDER_NOT_FOUND /
  -- ALREADY_PAID_DIFFERENT_INTENT / ORDER_NOT_PENDING still take priority) but
  -- strictly before any inventory or ticket mutation below.
  if p_paid_amount is null or p_paid_amount <> v_order.total_satang then
    raise exception 'AMOUNT_MISMATCH' using errcode = '22023';
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

revoke execute on function confirm_order_paid(uuid, text, bigint) from public, anon, authenticated;
grant execute on function confirm_order_paid(uuid, text, bigint) to service_role;
