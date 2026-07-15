import { Pool, Client } from "pg";

/**
 * These helpers back the Phase 2 DB-integration tests (tests/*.test.ts). They
 * talk directly to Postgres over the `pg` driver instead of supabase-js,
 * because the thing under test is the SQL in supabase/migrations/0002_functions_rls.sql
 * itself (concurrency-safe inventory math), not the thin Next.js route handlers
 * that call it. All tests in this suite require a real Postgres instance with
 * both migrations applied — see the header comment in
 * tests/oversell-concurrency.test.ts for full setup instructions.
 */

export function hasDatabaseUrl(): boolean {
  return !!process.env.DATABASE_URL;
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. These are Postgres integration tests that run " +
        "reserve_tickets()/confirm_order_paid()/expire_stale_orders()/promote_waitlist() " +
        "directly against a real database (a race condition cannot be verified against a mock). " +
        "Start a local Supabase stack (`supabase start`, which auto-applies " +
        "supabase/migrations/*) and point DATABASE_URL at its direct Postgres port, e.g.\n\n" +
        "  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres\n\n" +
        "See .env.test.example and the setup notes at the top of " +
        "tests/oversell-concurrency.test.ts."
    );
  }
  return url;
}

let pool: Pool | undefined;

/** Shared pool for setup/teardown/assertion queries (not for simulated concurrent buyers — see connectAsUser). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getDatabaseUrl(), max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Fails fast with a clear message if the migrations haven't been applied to
 * whatever DATABASE_URL points at, instead of every test timing out on a
 * confusing "function reserve_tickets does not exist" error.
 */
export async function assertMigrationsApplied(p: Pool): Promise<void> {
  const { rows } = await p.query(
    `select proname from pg_proc where proname in ('reserve_tickets', 'confirm_order_paid', 'expire_stale_orders', 'promote_waitlist')`
  );
  const found = new Set(rows.map((r) => r.proname));
  const required = ["reserve_tickets", "confirm_order_paid", "expire_stale_orders", "promote_waitlist"];
  const missing = required.filter((fn) => !found.has(fn));
  if (missing.length > 0) {
    throw new Error(
      `DATABASE_URL is reachable but missing functions: ${missing.join(", ")}. ` +
        `Run the migrations first: supabase db reset (or supabase start on a fresh project).`
    );
  }
}

/**
 * Opens a brand-new physical connection scoped to one simulated request —
 * mirrors how PostgREST handles each HTTP call: a fresh session with
 * `request.jwt.claims` set so auth.uid() inside the SECURITY DEFINER RPCs
 * resolves to p_userId. Caller must .end() it (callAsUser below does this
 * automatically).
 */
export async function connectAsUser(userId: string): Promise<Client> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  await client.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  // Some Supabase auth.uid() implementations read the flattened GUC directly
  // instead of/in addition to the JSON blob — set both so this works across
  // local Supabase Postgres image versions.
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  return client;
}

export interface RpcError {
  message: string; // the RAISE EXCEPTION 'CODE' text, e.g. "SOLD_OUT" — matches lib/errors.ts's mapRpcError
  sqlstate?: string;
}

export interface RpcResult<T> {
  data: T | null;
  error: RpcError | null;
}

/**
 * Calls a SQL statement as the given user over its own fresh connection —
 * one simulated HTTP request. Resolves (never rejects) with a normalized
 * {data, error} pair so concurrency tests can Promise.all/queue hundreds of
 * these without one rejection aborting the whole batch, the same way
 * supabase-js's .rpc() returns {data, error} instead of throwing.
 */
export async function callAsUser<T = Record<string, unknown>>(
  userId: string,
  sql: string,
  params: unknown[]
): Promise<RpcResult<T>> {
  const client = await connectAsUser(userId);
  try {
    const result = await client.query(sql, params);
    return { data: (result.rows[0] as T) ?? null, error: null };
  } catch (err) {
    const pgErr = err as { message?: string; code?: string };
    return { data: null, error: { message: (pgErr.message ?? "").trim(), sqlstate: pgErr.code } };
  } finally {
    await client.end();
  }
}

/** RPC call shape shared by every reserve_tickets() invocation across the test files. */
export const RESERVE_TICKETS_SQL = "select * from reserve_tickets($1::uuid, $2::jsonb, $3::text)";

export interface ReserveTicketsRow {
  order_id: string;
  status: string;
  expires_at: string;
  subtotal_satang: string | number;
  discount_satang: string | number;
  total_satang: string | number;
}
