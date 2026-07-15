import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { mapRpcError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/events/:eventId/stats
 * Organizer dashboard aggregate (tickets issued/checked-in, revenue, per-tier
 * breakdown) for one event. Auth required, and the caller must be staff (any
 * org_member role) of the org that owns the event — enforced inside
 * event_checkin_stats() itself (see
 * supabase/migrations/0012_checkin_dashboard.sql), not here.
 *
 * Always no-store: the dashboard is expected to poll this on an interval to
 * stay live during an event, so every response must reflect the current
 * state rather than a cached one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  const idCheck = uuidSchema.safeParse(eventId);
  if (!idCheck.success) {
    return NextResponse.json(
      { error: "INVALID_EVENT_ID", message: "Malformed event id." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "UNAUTHENTICATED", message: "Sign in required." },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const { data, error } = await supabase.rpc("event_checkin_stats", { p_event_id: eventId }).single();

  if (error) {
    const mapped = mapRpcError(error);
    mapped.headers.set("Cache-Control", "no-store");
    return mapped;
  }

  if (!data) {
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Could not load event stats." },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    {
      totalTickets: data.total_tickets,
      checkedInCount: data.checked_in_count,
      checkInRate: data.check_in_rate,
      totalReserved: data.total_reserved,
      totalSold: data.total_sold,
      revenueSatang: data.revenue_satang,
      tierBreakdown: data.tier_breakdown,
    },
    { headers: NO_STORE_HEADERS }
  );
}
