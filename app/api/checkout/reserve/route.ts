import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reserveTicketsSchema } from "@/lib/validation";
import { isDeadlock, mapRpcError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/reserve
 * Places a time-limited hold on the requested ticket quantities and returns
 * the pending order. Business rules (quota, per-user limit, promo validity)
 * all live in the reserve_tickets() SQL function — this route is a thin,
 * validated pass-through plus a single retry on transaction deadlock.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = reserveTicketsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { eventId, items, promoCode } = parsed.data;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED", message: "Sign in required." }, { status: 401 });
  }

  // General per-user cap on reservation attempts.
  const reserveLimited = await enforceRateLimit(
    supabase,
    `reserve:${user.id}`,
    RATE_LIMITS.RESERVE.max,
    RATE_LIMITS.RESERVE.windowSeconds
  );
  if (reserveLimited) return reserveLimited;

  // Tighter, separate budget when a promo code is attached — this is the path
  // an attacker would hammer to enumerate valid codes or their discount rules
  // (see the PROMO_* response collapsing in lib/errors.ts, which closes the
  // information side of this same oracle).
  if (promoCode) {
    const promoLimited = await enforceRateLimit(
      supabase,
      `promo:${user.id}`,
      RATE_LIMITS.RESERVE_WITH_PROMO.max,
      RATE_LIMITS.RESERVE_WITH_PROMO.windowSeconds
    );
    if (promoLimited) return promoLimited;
  }

  const rpcParams = {
    p_event_id: eventId,
    p_items: items.map((item) => ({ tier_id: item.tierId, quantity: item.quantity })),
    p_promo_code: promoCode ?? null,
  };

  let { data, error } = await supabase.rpc("reserve_tickets", rpcParams).single();

  // Consistent lock ordering in reserve_tickets() should prevent deadlocks, but a
  // concurrent internal_release_order() sweep from pg_cron can still collide with
  // it on rare occasions — retry exactly once per architect's guidance.
  if (error && isDeadlock(error)) {
    ({ data, error } = await supabase.rpc("reserve_tickets", rpcParams).single());
  }

  if (error) {
    return mapRpcError(error);
  }

  if (!data) {
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "Reservation failed unexpectedly." }, { status: 500 });
  }

  // The Supabase client isn't generated with a typed schema, so rpc().single()
  // yields `{}` — cast to the shape reserve_tickets actually RETURNS (see
  // supabase/migrations/0004_fix_reserve_tickets_ambiguous_status.sql).
  const row = data as {
    order_id: string;
    status: string;
    expires_at: string;
    subtotal_satang: number;
    discount_satang: number;
    total_satang: number;
  };

  return NextResponse.json(
    {
      orderId: row.order_id,
      status: row.status,
      expiresAt: row.expires_at,
      subtotalSatang: row.subtotal_satang,
      discountSatang: row.discount_satang,
      totalSatang: row.total_satang,
    },
    { status: 201 }
  );
}
