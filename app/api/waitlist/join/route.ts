import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { waitlistJoinSchema } from "@/lib/validation";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNIQUE_VIOLATION = "23505";

/**
 * POST /api/waitlist/join
 * Adds the current user to a tier's waitlist. Insert-only write is safe to do
 * directly against the table (RLS: waitlist_insert_owner requires user_id =
 * auth.uid()) — no business logic here beyond "is this tier actually sold out".
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = waitlistJoinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { eventId, tierId } = parsed.data;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED", message: "Sign in required." }, { status: 401 });
  }

  const waitlistLimited = await enforceRateLimit(
    supabase,
    `waitlist:${user.id}`,
    RATE_LIMITS.WAITLIST_JOIN.max,
    RATE_LIMITS.WAITLIST_JOIN.windowSeconds
  );
  if (waitlistLimited) return waitlistLimited;

  // Confirm the tier belongs to this event and is actually out of stock before
  // letting someone join the waitlist — otherwise the feature is meaningless.
  const { data: tier, error: tierError } = await supabase
    .from("ticket_tier")
    .select("id, event_id, tier_inventory(quota, reserved, sold)")
    .eq("id", tierId)
    .eq("event_id", eventId)
    .maybeSingle();

  if (tierError) {
    console.error("Failed to load tier for waitlist join", tierError);
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "Could not load ticket tier." }, { status: 500 });
  }

  if (!tier) {
    return NextResponse.json({ error: "TIER_NOT_FOUND", message: "Ticket tier not found for this event." }, { status: 404 });
  }

  const inventory = Array.isArray(tier.tier_inventory) ? tier.tier_inventory[0] : tier.tier_inventory;
  const isSoldOut = !!inventory && inventory.reserved + inventory.sold >= inventory.quota;

  if (!isSoldOut) {
    return NextResponse.json(
      { error: "TIER_AVAILABLE", message: "This ticket tier still has availability — no need to join the waitlist." },
      { status: 409 }
    );
  }

  const { data: entry, error: insertError } = await supabase
    .from("waitlist_entry")
    .insert({ event_id: eventId, tier_id: tierId, user_id: user.id })
    .select("id, status, created_at")
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      return NextResponse.json(
        { error: "ALREADY_ON_WAITLIST", message: "You are already on the waitlist for this ticket tier." },
        { status: 409 }
      );
    }
    console.error("Failed to insert waitlist entry", insertError);
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "Could not join waitlist." }, { status: 500 });
  }

  return NextResponse.json(
    { id: entry.id, status: entry.status, createdAt: entry.created_at },
    { status: 201 }
  );
}
