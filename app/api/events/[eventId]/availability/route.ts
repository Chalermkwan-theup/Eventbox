import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events/:eventId/availability
 * Public, unauthenticated endpoint — no auth check and no rate limit by
 * design (it's read-only, cheap, and meant to be pollable from a public event
 * page). tier_inventory_select / ticket_tier_select RLS already restrict this
 * to published events for anon callers (is_org_member() is false without a
 * session), so an unpublished/nonexistent event id simply yields an empty
 * `tiers` array rather than a distinct 404 — deliberately not distinguished,
 * to avoid leaking draft event ids by trial and error.
 */
export async function GET(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  const idCheck = uuidSchema.safeParse(eventId);
  if (!idCheck.success) {
    return NextResponse.json({ error: "INVALID_EVENT_ID", message: "Malformed event id." }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: tiers, error } = await supabase
    .from("ticket_tier")
    .select("id, name, price_satang, sort_order, tier_inventory(quota, reserved, sold)")
    .eq("event_id", eventId)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("Failed to load tier availability", error);
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "Could not load availability." }, { status: 500 });
  }

  const result = (tiers ?? []).map((tier) => {
    // tier_inventory is a 1:1 relation keyed off ticket_tier.id, but
    // PostgREST's inferred shape (object vs. single-element array) depends on
    // how it detects the FK — handle both defensively (same pattern as
    // app/api/waitlist/join/route.ts).
    const inventory = Array.isArray(tier.tier_inventory) ? tier.tier_inventory[0] : tier.tier_inventory;
    // No inventory row yet (admin hasn't provisioned quota for this tier) ->
    // treat as zero remaining rather than erroring the whole response.
    const remaining = inventory ? Math.max(inventory.quota - inventory.reserved - inventory.sold, 0) : 0;

    return {
      tierId: tier.id,
      name: tier.name,
      remaining,
      priceSatang: tier.price_satang,
    };
  });

  return NextResponse.json(
    { tiers: result },
    { headers: { "Cache-Control": "s-maxage=5, stale-while-revalidate=10" } }
  );
}
