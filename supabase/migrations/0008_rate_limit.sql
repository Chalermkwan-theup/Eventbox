-- 0008_rate_limit.sql
-- Security H1 (part 1) — Postgres-based rate limiting.
--
-- Design: fixed-window counter, one row per (bucket_key, window). The window
-- boundary is computed by flooring `now()` to a multiple of p_window_seconds,
-- so all calls within the same window agree on the same window_start without
-- any extra coordination. This is simpler than a sliding log and is atomic in
-- a single `insert ... on conflict do update ... returning`, which is what
-- actually matters under concurrency (no read-then-write race).
--
-- bucket_key is caller-defined (e.g. 'reserve:<user_id>', 'promo:<user_id>')
-- so the same table/RPC backs every rate-limited action in the app.
create table if not exists rate_limit (
  bucket_key   text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket_key, window_start)
);

-- Deny-by-default RLS: intentionally NO policies at all. anon/authenticated can
-- never read or write this table directly, even if a future grant slipped in by
-- mistake — the only supported entry point is the SECURITY DEFINER RPC below,
-- which (as table owner) bypasses RLS.
alter table rate_limit enable row level security;

-- ============================================================================
-- check_rate_limit — atomic "increment and check" for one bucket/window.
-- Returns true when the caller is within limit (and the increment already
-- happened), false when the limit was already exceeded for this window.
-- ============================================================================
create or replace function check_rate_limit(
  p_key text,
  p_max int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        int;
begin
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'RATE_LIMIT_INVALID_KEY' using errcode = '22023';
  end if;
  if p_max is null or p_max <= 0 then
    raise exception 'RATE_LIMIT_INVALID_MAX' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'RATE_LIMIT_INVALID_WINDOW' using errcode = '22023';
  end if;

  -- Bucket `now()` into a p_window_seconds-wide slot aligned to the Unix
  -- epoch, so independent calls in the same window always compute the same
  -- window_start without needing to read anything first.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into rate_limit (bucket_key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
    do update set count = rate_limit.count + 1
  returning count into v_count;

  -- Lazy purge: drop this key's stale windows on the same statement that
  -- already touched it, so the table doesn't grow unbounded. This only ever
  -- deletes rows for the bucket_key just written (cheap, uses the PK), so it
  -- adds no extra table-wide scan. A pg_cron sweep (e.g.
  -- `delete from rate_limit where window_start < now() - interval '1 day'`)
  -- can be added later to also clean up keys that stop being called
  -- altogether, but is not required for correctness.
  delete from rate_limit
  where bucket_key = p_key
    and window_start < v_window_start;

  return v_count <= p_max;
end;
$$;

-- Lesson learned: Supabase grants EXECUTE to anon/authenticated via default
-- privileges, not via PUBLIC — `revoke ... from public` alone is a no-op for
-- them. Revoke explicitly, then re-grant only to the roles allowed to call this.
revoke execute on function check_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function check_rate_limit(text, int, int) to authenticated, service_role;
