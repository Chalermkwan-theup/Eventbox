import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

/** SQLSTATE raised by Postgres when it detects a deadlock (see 0002_functions_rls.sql). */
export const DEADLOCK_SQLSTATE = "40P01";

/**
 * Maps the business-error messages raised via `RAISE EXCEPTION '<CODE>'` inside
 * our SQL functions (see 0002_functions_rls.sql) to an HTTP status + safe
 * client-facing message. Anything not in this table is treated as an
 * unexpected server error (500) and logged, not echoed to the client.
 */
const KNOWN_RPC_ERRORS: Record<string, { status: number; message: string }> = {
  UNAUTHENTICATED: { status: 401, message: "Sign in required." },
  EMPTY_ITEMS: { status: 400, message: "At least one ticket item is required." },
  DUPLICATE_TIER_IN_REQUEST: { status: 400, message: "Duplicate ticket tier in request." },
  INVALID_QUANTITY: { status: 400, message: "Ticket quantity must be a positive integer." },
  EVENT_NOT_ON_SALE: { status: 409, message: "This event is not currently on sale." },
  INVALID_TIER_FOR_EVENT: { status: 400, message: "One or more ticket tiers do not belong to this event." },
  // PROMO_INVALID / PROMO_NOT_STARTED / PROMO_EXPIRED / PROMO_EXHAUSTED are
  // intentionally NOT listed here — see PROMO_ORACLE_CODES below. They must
  // never reach the client as distinct codes/messages.
  PROMO_PER_USER_LIMIT_EXCEEDED: { status: 409, message: "You have already used this promo code the maximum number of times." },
  PER_USER_LIMIT_EXCEEDED: { status: 409, message: "You have reached the per-person limit for this ticket tier." },
  SOLD_OUT: { status: 409, message: "Selected ticket tier is sold out." },
  ZERO_TOTAL_NOT_SUPPORTED: { status: 422, message: "This order totals zero — free/fully-discounted orders are not supported yet." },
  // ORDER_NOT_PENDING is reachable two ways: attach_payment_intent() (called
  // from app/api/checkout/[orderId]/pay/route.ts via mapRpcError — the live
  // path) and confirm_order_paid() (webhook-only, handled by its own manual
  // code switch in app/api/webhooks/stripe/route.ts, never via mapRpcError).
  ORDER_NOT_PENDING: { status: 409, message: "Order is no longer awaiting payment." },
  // ORDER_NOT_FOUND / ALREADY_PAID_DIFFERENT_INTENT / TICKET_SERIAL_GENERATION_FAILED
  // are only ever raised by confirm_order_paid(), which today is only called
  // from the Stripe webhook via the service-role client with its own manual
  // error-code switch (not mapRpcError) — see app/api/webhooks/stripe/route.ts.
  // Kept mapped here as future-proofing/defense-in-depth in case confirm_order_paid
  // (or an equivalent RPC raising the same codes) is ever invoked from a route
  // that goes through mapRpcError instead.
  ORDER_NOT_FOUND: { status: 404, message: "Order not found." },
  ALREADY_PAID_DIFFERENT_INTENT: { status: 409, message: "Order was already paid with a different payment." },
  TICKET_SERIAL_GENERATION_FAILED: { status: 500, message: "Could not issue tickets. Please contact support." },
  // issue_ticket_qr_token() (0011_phase3_qr_realtime.sql) — GET /api/tickets/:ticketId/qr.
  // TICKET_NOT_FOUND also covers "not your ticket" (see the RPC's ownership check),
  // so a 404 here never confirms whether a given ticket id exists for someone else.
  // check_in_ticket() (0012_checkin_dashboard.sql) also raises this — same
  // "id doesn't exist" case, distinct from NOT_EVENT_STAFF below.
  TICKET_NOT_FOUND: { status: 404, message: "Ticket not found." },
  TICKET_NOT_ACTIVE: { status: 403, message: "This ticket is no longer active." },
  // check_in_ticket() / event_checkin_stats() (0012_checkin_dashboard.sql) —
  // POST /api/checkin, GET /api/events/:eventId/stats.
  // INVALID_TOKEN deliberately covers both "malformed token" and "well-formed
  // token with a wrong/forged MAC" — see the RPC's comment on why those two
  // cases must not be distinguishable to the caller.
  INVALID_TOKEN: { status: 400, message: "Invalid or unrecognized ticket QR code." },
  NOT_EVENT_STAFF: { status: 403, message: "You are not staff for this event." },
  TICKET_VOID: { status: 409, message: "This ticket has been voided and cannot be checked in." },
  EVENT_NOT_FOUND: { status: 404, message: "Event not found." },
  // TICKET_ALREADY_CHECKED_IN is handled specially in app/api/checkin/route.ts
  // (needs to surface the original checked_in_at from error.details, which
  // mapRpcError()'s {error, message} shape doesn't carry). Kept mapped here
  // too as defense-in-depth in case it's ever raised through a code path that
  // goes through mapRpcError directly instead.
  TICKET_ALREADY_CHECKED_IN: { status: 409, message: "This ticket has already been checked in." },
};

/**
 * Security H1 (part 2) — promo enumeration oracle.
 *
 * reserve_tickets() raises four distinct SQL error codes that all mean "this
 * promo code cannot be used for this order", but for different underlying
 * reasons (unknown/inactive code, not-yet-started, expired, redemption cap
 * hit). Surfacing them as distinct HTTP responses lets a caller binary-search
 * which promo codes exist and their validity windows/limits purely from error
 * codes, without ever needing a code that actually works. PROMO_PER_USER_LIMIT_EXCEEDED
 * is deliberately excluded from this list — it only reveals the caller's own
 * redemption history, not anything about the code itself.
 *
 * Collapsed into one response, indistinguishable by status code or message.
 * The specific reason is still logged server-side (console.error below) for
 * support/ops debugging.
 */
const PROMO_ORACLE_CODES = new Set(["PROMO_INVALID", "PROMO_NOT_STARTED", "PROMO_EXPIRED", "PROMO_EXHAUSTED"]);
const PROMO_GENERIC_RESPONSE = {
  status: 422,
  error: "PROMO_NOT_APPLICABLE",
  message: "This promo code can't be applied to this order.",
} as const;

export function isDeadlock(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === DEADLOCK_SQLSTATE;
}

/** Extracts the `RAISE EXCEPTION 'CODE'` message PostgREST forwards as `error.message`. */
export function mapRpcError(error: PostgrestError): NextResponse {
  const code = error.message?.trim();

  if (code && PROMO_ORACLE_CODES.has(code)) {
    console.error(`Promo code rejected (${code}) — returning generic response to client`, error);
    return NextResponse.json(
      { error: PROMO_GENERIC_RESPONSE.error, message: PROMO_GENERIC_RESPONSE.message },
      { status: PROMO_GENERIC_RESPONSE.status }
    );
  }

  const known = code ? KNOWN_RPC_ERRORS[code] : undefined;

  if (known) {
    return NextResponse.json({ error: code, message: known.message }, { status: known.status });
  }

  console.error("Unhandled RPC error", error);
  return NextResponse.json(
    { error: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
    { status: 500 }
  );
}
