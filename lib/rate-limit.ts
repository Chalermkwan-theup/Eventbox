import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-route rate limit budgets. Numbers are deliberately generous for normal
 * usage and tight for the promo-code path, which is the one an attacker would
 * hammer to enumerate valid/invalid codes (see the PROMO_* oracle fix in
 * lib/errors.ts) or brute-force a discount.
 */
export const RATE_LIMITS = {
  RESERVE: { max: 20, windowSeconds: 60 },
  RESERVE_WITH_PROMO: { max: 10, windowSeconds: 60 },
  PAY: { max: 10, windowSeconds: 60 },
  WAITLIST_JOIN: { max: 10, windowSeconds: 60 },
  // QR tokens are re-derived on demand (nothing persisted) and cheap to
  // compute, so this budget is generous — 30/min comfortably covers a phone
  // screen re-rendering the code a few times while someone queues at the
  // gate, without leaving the endpoint open to unbounded hammering.
  QR: { max: 30, windowSeconds: 60 },
  // Gate staff scanning a fast-moving queue can legitimately hit this several
  // times a second — 120/min (~2/sec) covers that while still bounding a
  // compromised/malicious staff token from being used to brute-force ticket
  // ids or replay-scan at unbounded speed.
  CHECKIN: { max: 120, windowSeconds: 60 },
} as const;

function rateLimitedResponse(): NextResponse {
  return NextResponse.json(
    { error: "RATE_LIMITED", message: "Too many requests. Please slow down and try again shortly." },
    { status: 429 }
  );
}

/**
 * Enforces a fixed-window rate limit via the check_rate_limit() Postgres RPC
 * (see supabase/migrations/0008_rate_limit.sql). Returns a ready-to-send 429
 * response when the caller is over budget, or `null` when the caller may
 * proceed (the increment has already happened atomically inside the RPC).
 *
 * Fails CLOSED: an unexpected error from the RPC itself (missing grant,
 * connectivity issue) returns a 500 rather than silently letting the request
 * through — a rate limiter that fails open on its own errors defeats the
 * purpose it exists for. This mirrors how mapRpcError() in lib/errors.ts
 * treats unrecognized RPC errors as 500s rather than swallowing them.
 */
export async function enforceRateLimit(
  supabase: SupabaseClient,
  key: string,
  max: number,
  windowSeconds: number
): Promise<NextResponse | null> {
  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_key: key,
    p_max: max,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error(`check_rate_limit RPC failed for key="${key}"`, error);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }

  if (data === false) {
    return rateLimitedResponse();
  }

  return null;
}
