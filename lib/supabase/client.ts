import { createBrowserClient } from "@supabase/ssr";

/**
 * Anon-key Supabase client for Client Components. Intended for:
 *   - subscribing to Realtime changes on `orders` (see
 *     supabase/migrations/0011_phase3_qr_realtime.sql) to react to a pending
 *     order flipping to 'paid' without a hard poll loop
 *   - falling back to polling GET /api/checkout/:orderId when Realtime is
 *     unavailable (frontend-dev's call)
 *
 * RLS-governed exactly like lib/supabase/server.ts (orders_select scopes rows
 * to their owner or org staff) — never the service-role key. Only import this
 * from files with a "use client" directive; it touches browser-only APIs
 * (cookies/storage) that don't exist during server rendering.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase configuration: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY"
    );
  }

  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
