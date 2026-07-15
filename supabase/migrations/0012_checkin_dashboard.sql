-- 0012_checkin_dashboard.sql
-- Phase 4 — gate check-in RPC + organizer dashboard stats RPC.
--
-- Lessons carried forward from Phase 2/3 (see 0003, 0007, 0011):
--   * pgcrypto (hmac/digest/encode/decode) lives in `extensions` on Supabase,
--     not `public` — any function calling it needs
--     `set search_path = public, extensions`.
--   * Supabase grants EXECUTE to anon/authenticated via default privileges,
--     not PUBLIC — `revoke ... from public` alone is a no-op for them, must
--     revoke from anon/authenticated explicitly before re-granting narrowly.
--   * RETURNS TABLE OUT parameters become implicitly-declared PL/pgSQL
--     variables; a bare identifier that also happens to be a table/CTE column
--     name is ambiguous (42702) unless `#variable_conflict use_column` picks
--     a side. Both functions below use it defensively.

-- ============================================================================
-- (a) Audit column — who scanned a ticket in, for the check-in RPC to record.
-- ============================================================================
alter table ticket
  add column checked_in_by uuid references auth.users(id);

-- Query pattern for both RPCs below groups/filters ticket rows by tier_id,
-- which had no supporting index (only owner_user_id / event_id / order_item_id
-- were indexed in 0001) — added here since event_checkin_stats() now does
-- this on every dashboard poll.
create index if not exists ticket_tier_idx on ticket(tier_id);

-- Speeds up the revenue_satang aggregate in event_checkin_stats() (sum of
-- paid orders for one event) without a full scan of every order ever placed
-- for the event across all statuses.
create index if not exists orders_event_paid_idx on orders(event_id) where status = 'paid';

-- ============================================================================
-- (b) check_in_ticket — scans a QR token and admits the ticket, atomically.
--
-- Token format (must match issue_ticket_qr_token() in
-- 0011_phase3_qr_realtime.sql exactly):
--   'TKT1.' || b64url(uuid_send(ticket_id)) || '.' || b64url(hmac('TKT1' ||
--   uuid_send(ticket_id), qr_secret, 'sha256'))
-- where b64url(x) = rtrim(translate(encode(x,'base64'),'+/','-_'), '=').
--
-- Every failure mode below deliberately raises a distinct code so the API
-- layer can map it to the right HTTP status (see mapRpcError in lib/errors.ts
-- and app/api/checkin/route.ts) — but note a malformed token and a
-- structurally valid token with a forged/incorrect MAC are BOTH surfaced as
-- INVALID_TOKEN (never split into two codes), so a scanner client can't use
-- the error code as an oracle to tell "not our token format" apart from
-- "someone tampered with a real ticket's MAC".
-- ============================================================================
create or replace function check_in_ticket(p_token text)
returns table (
  ticket_id       uuid,
  serial_no       text,
  tier_name       text,
  attendee_email  text,
  checked_in_at   timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_user_id       uuid := auth.uid();
  v_parts         text[];
  v_id_seg        text;
  v_mac_seg       text;
  v_id_bytes      bytea;
  v_mac_bytes     bytea;
  v_ticket_id     uuid;
  v_ticket        record;
  v_org_id        uuid;
  v_expected_mac  bytea;
  v_tier_name     text;
  v_email         text;
  v_checked_in_at timestamptz;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;

  v_parts := string_to_array(p_token, '.');
  if array_length(v_parts, 1) <> 3 or v_parts[1] <> 'TKT1' then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;

  v_id_seg := v_parts[2];
  v_mac_seg := v_parts[3];

  -- Decode the ticket id segment: b64url -> bytea -> uuid. Any malformed
  -- base64 or a decoded length that doesn't parse as a uuid (wrong byte
  -- count, non-hex garbage) is caught here and folded into INVALID_TOKEN
  -- rather than a raw 500/parse error.
  begin
    v_id_bytes := decode(
      translate(v_id_seg, '-_', '+/') || repeat('=', (4 - length(v_id_seg) % 4) % 4),
      'base64'
    );
    v_ticket_id := encode(v_id_bytes, 'hex')::uuid;
  exception when others then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end;

  -- Decode the MAC segment the same way. A malformed base64 payload here is
  -- also just INVALID_TOKEN — same reasoning as above.
  begin
    v_mac_bytes := decode(
      translate(v_mac_seg, '-_', '+/') || repeat('=', (4 - length(v_mac_seg) % 4) % 4),
      'base64'
    );
  exception when others then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end;

  -- Lock the ticket row for the remainder of this transaction. This is what
  -- makes check-in first-scan-wins: a second concurrent scan of the same
  -- physical ticket (duplicated/replayed QR image) blocks here until the
  -- first transaction commits, then sees status = 'checked_in' and loses.
  select t.id, t.serial_no, t.status, t.checked_in_at, t.qr_secret, t.tier_id, t.event_id, t.owner_user_id
    into v_ticket
  from ticket t
  where t.id = v_ticket_id
  for update;

  if not found then
    raise exception 'TICKET_NOT_FOUND' using errcode = '22023';
  end if;

  -- Authz: caller must be staff (any org_member role) of the org that owns
  -- this ticket's event. Checked before the HMAC verify per spec ordering —
  -- a non-staff caller never learns whether a token's MAC would have been
  -- valid.
  select e.org_id into v_org_id from event e where e.id = v_ticket.event_id;

  if v_org_id is null or not is_org_member(v_org_id) then
    raise exception 'NOT_EVENT_STAFF' using errcode = '22023';
  end if;

  -- Recompute the HMAC from the ticket's stored qr_secret and compare
  -- against the one presented in the token. Comparing digest(a) = digest(b)
  -- instead of the raw bytea values directly avoids a variable-length,
  -- early-exit byte-by-byte comparison that could leak a valid MAC one byte
  -- at a time via a timing side-channel (see the tail comment in
  -- 0011_phase3_qr_realtime.sql).
  v_expected_mac := hmac(convert_to('TKT1', 'UTF8') || uuid_send(v_ticket.id), v_ticket.qr_secret, 'sha256');

  if digest(v_mac_bytes, 'sha256') <> digest(v_expected_mac, 'sha256') then
    raise exception 'INVALID_TOKEN' using errcode = '22023';
  end if;

  -- Atomic first-scan-wins status transition, still under the row lock
  -- taken above.
  if v_ticket.status = 'void' then
    raise exception 'TICKET_VOID' using errcode = '22023';
  elsif v_ticket.status = 'checked_in' then
    -- Detail carries the original check-in timestamp so the scanner UI can
    -- show "already checked in at HH:MM" instead of a bare error (see
    -- app/api/checkin/route.ts, which reads error.details off the
    -- PostgrestError).
    raise exception 'TICKET_ALREADY_CHECKED_IN'
      using errcode = '22023', detail = coalesce(v_ticket.checked_in_at::text, '');
  end if;

  -- Only 'valid' remains (ticket_status has exactly three values).
  update ticket
    set status = 'checked_in', checked_in_at = now(), checked_in_by = v_user_id
  where id = v_ticket.id
  returning checked_in_at into v_checked_in_at;

  select tt.name into v_tier_name from ticket_tier tt where tt.id = v_ticket.tier_id;
  select u.email into v_email from auth.users u where u.id = v_ticket.owner_user_id;

  return query select v_ticket.id, v_ticket.serial_no, v_tier_name, v_email, v_checked_in_at;
end;
$$;

revoke execute on function check_in_ticket(text) from public, anon;
-- Staff call this directly through the RLS (anon-key) client — the
-- is_org_member() guard inside the function is the actual authorization
-- gate, not RLS. service_role is also granted for any future internal/batch
-- check-in tooling.
grant execute on function check_in_ticket(text) to authenticated, service_role;

-- ============================================================================
-- (c) event_checkin_stats — organizer dashboard aggregate for one event.
-- ============================================================================
create or replace function event_checkin_stats(p_event_id uuid)
returns table (
  total_tickets     bigint,
  checked_in_count  bigint,
  check_in_rate     numeric,
  total_reserved    bigint,
  total_sold        bigint,
  revenue_satang    bigint,
  tier_breakdown    jsonb
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org_id uuid;
begin
  select org_id into v_org_id from event where id = p_event_id;

  if v_org_id is null then
    raise exception 'EVENT_NOT_FOUND' using errcode = '22023';
  end if;

  if not is_org_member(v_org_id) then
    raise exception 'NOT_EVENT_STAFF' using errcode = '22023';
  end if;

  return query
  with tier_stats as (
    select
      tt.id                                                       as tier_id,
      tt.name                                                      as tier_name,
      tt.sort_order                                                as tier_sort_order,
      coalesce(ti.quota, 0)                                        as tier_quota,
      coalesce(ti.reserved, 0)                                     as tier_reserved,
      coalesce(ti.sold, 0)                                         as tier_sold,
      count(t.id) filter (where t.status in ('valid', 'checked_in')) as tier_issued,
      count(t.id) filter (where t.status = 'checked_in')            as tier_checked_in
    from ticket_tier tt
    left join tier_inventory ti on ti.tier_id = tt.id
    left join ticket t on t.tier_id = tt.id
    where tt.event_id = p_event_id
    group by tt.id, tt.name, tt.sort_order, ti.quota, ti.reserved, ti.sold
  ),
  revenue as (
    -- sum() over bigint returns numeric; cast back to bigint to match the
    -- declared revenue_satang OUT column type (else 42804 "structure of query
    -- does not match function result type" on every call — caught by running).
    select coalesce(sum(o.total_satang), 0)::bigint as paid_revenue_satang
    from orders o
    where o.event_id = p_event_id and o.status = 'paid'
  )
  select
    coalesce(sum(ts.tier_issued), 0)::bigint     as total_tickets,
    coalesce(sum(ts.tier_checked_in), 0)::bigint as checked_in_count,
    case
      when coalesce(sum(ts.tier_issued), 0) = 0 then 0::numeric
      else round(sum(ts.tier_checked_in)::numeric / sum(ts.tier_issued), 4)
    end                                           as check_in_rate,
    coalesce(sum(ts.tier_reserved), 0)::bigint   as total_reserved,
    coalesce(sum(ts.tier_sold), 0)::bigint       as total_sold,
    (select paid_revenue_satang from revenue)     as revenue_satang,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'tier_id', ts.tier_id,
          'name', ts.tier_name,
          'quota', ts.tier_quota,
          'sold', ts.tier_sold,
          'checked_in', ts.tier_checked_in
        )
        order by ts.tier_sort_order
      ) filter (where ts.tier_id is not null),
      '[]'::jsonb
    )                                             as tier_breakdown
  from tier_stats ts;
end;
$$;

revoke execute on function event_checkin_stats(uuid) from public, anon;
grant execute on function event_checkin_stats(uuid) to authenticated, service_role;
