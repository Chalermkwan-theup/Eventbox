-- 0011_phase3_qr_realtime.sql
-- Phase 3 — QR ticket token issuance + Realtime for order status polling.
--
-- Token format (architect spec): 'TKT1.' || b64url(uuid_send(ticket_id)) ||
-- '.' || b64url(hmac('TKT1' || uuid_send(ticket_id), qr_secret, 'sha256'))
-- where b64url(x) = rtrim(translate(encode(x,'base64'),'+/','-_'),'=').
--
-- Nothing is persisted by this function — the token is derived on demand from
-- ticket.qr_secret (already generated per-ticket in confirm_order_paid, see
-- 0001/0002), so re-issuing a token for the same ticket is idempotent and the
-- token itself never needs to be stored or rotated.
create or replace function issue_ticket_qr_token(p_ticket_id uuid)
returns text
language plpgsql
security definer
-- Lesson learned (0007/0009): hmac()/digest()/encode()/gen_random_bytes() from
-- pgcrypto live in the `extensions` schema on Supabase, not `public` — widen
-- search_path or every call fails with 42883 "function hmac(...) does not exist".
set search_path = public, extensions
as $$
declare
  v_user_id  uuid := auth.uid();
  v_ticket   record;
  v_id_bytes bytea;
  v_mac      bytea;
begin
  -- No special-case for v_user_id is null: owner_user_id on ticket is NOT NULL,
  -- so `is distinct from null` below is unconditionally true and falls through
  -- to the same TICKET_NOT_FOUND branch as a real ownership mismatch — avoids
  -- leaking whether a ticket id exists to an unauthenticated caller.
  select id, owner_user_id, status, qr_secret
    into v_ticket
  from ticket
  where id = p_ticket_id;

  if not found then
    raise exception 'TICKET_NOT_FOUND' using errcode = '22023';
  end if;

  if v_ticket.owner_user_id is distinct from v_user_id then
    raise exception 'TICKET_NOT_FOUND' using errcode = '22023';
  end if;

  if v_ticket.status <> 'valid' then
    raise exception 'TICKET_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_id_bytes := uuid_send(p_ticket_id);
  v_mac := hmac(convert_to('TKT1', 'UTF8') || v_id_bytes, v_ticket.qr_secret, 'sha256');

  return 'TKT1.'
    || rtrim(translate(encode(v_id_bytes, 'base64'), '+/', '-_'), '=')
    || '.'
    || rtrim(translate(encode(v_mac, 'base64'), '+/', '-_'), '=');
end;
$$;

-- Lesson learned (0003): Supabase grants EXECUTE to anon/authenticated via
-- default privileges, not via PUBLIC — `revoke ... from public` alone is a
-- no-op for them. Revoke explicitly, then re-grant only to authenticated
-- (must be signed in and own the ticket; anon never has a use for this).
revoke execute on function issue_ticket_qr_token(uuid) from public, anon;
grant execute on function issue_ticket_qr_token(uuid) to authenticated;

-- ============================================================================
-- Realtime — let clients subscribe to their own order's status changes
-- (pending_payment -> paid) instead of only polling GET /api/checkout/:id.
-- RLS (orders_select) already scopes what a subscriber can see; adding a table
-- to the publication does not bypass RLS for Realtime's row-level broadcasts.
--
-- Wrapped in a DO block: `alter publication ... add table` raises
-- duplicate_object if the table was already added by a previous run of this
-- migration (or manually against this project) — safe to no-op instead of
-- failing the migration.
-- ============================================================================
do $$
begin
  alter publication supabase_realtime add table orders;
exception
  when duplicate_object then
    null;
end
$$;

-- ============================================================================
-- Verify flow (Phase 4 — check-in RPC, not implemented in this migration):
--
-- The check-in RPC will parse a scanned token of the form
-- 'TKT1.<id_b64url>.<mac_b64url>', decode the ticket id, look up the ticket
-- (and its qr_secret) by that id, then independently RECOMPUTE the HMAC from
-- 'TKT1' || uuid_send(ticket_id) using the stored qr_secret and compare it to
-- the mac segment presented in the scanned token.
--
-- That comparison MUST be constant-time to avoid a timing side-channel that
-- would let an attacker recover a valid mac byte-by-byte. Postgres has no
-- built-in constant-time bytea comparison, so the accepted pattern (and the
-- one Phase 4 should use) is comparing SHA-256 digests of both sides instead
-- of the raw bytes directly:
--   digest(presented_mac, 'sha256') = digest(recomputed_mac, 'sha256')
-- `=` between two bytea digests of fixed, equal length is not a documented
-- constant-time guarantee from Postgres, but it removes the early-exit,
-- variable-length byte-by-byte comparison that a raw `presented_mac =
-- recomputed_mac` would otherwise perform, which is the actual leak this
-- guards against.
--
-- Check-in itself must be atomic and first-scan-wins: the RPC should
-- `select ... for update` the ticket row, verify status = 'valid' inside that
-- same transaction, and only then update status to 'checked_in' — so two
-- concurrent scans of the same physical ticket (e.g. duplicated/replayed QR
-- image) can never both succeed. The loser gets a distinct error (e.g.
-- 'TICKET_ALREADY_CHECKED_IN') rather than a silent duplicate admit.
-- ============================================================================
