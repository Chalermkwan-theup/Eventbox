import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkinSchema } from "@/lib/validation";
import { mapRpcError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/checkin
 * Admits a scanned ticket QR token at the gate. Auth required — the caller
 * must be signed in AND be staff (any org_member role) of the org that owns
 * the ticket's event; that authorization actually happens inside
 * check_in_ticket() (see supabase/migrations/0012_checkin_dashboard.sql), not
 * here. This route is a thin, validated pass-through plus one bit of
 * response shaping for the "already checked in" case (see below).
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_JSON", message: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const parsed = checkinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "Invalid request.", details: parsed.error.flatten() },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const { token } = parsed.data;
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

  // Gate staff scan in quick succession — see RATE_LIMITS.CHECKIN for the
  // budget rationale.
  const checkinLimited = await enforceRateLimit(
    supabase,
    `checkin:${user.id}`,
    RATE_LIMITS.CHECKIN.max,
    RATE_LIMITS.CHECKIN.windowSeconds
  );
  if (checkinLimited) {
    checkinLimited.headers.set("Cache-Control", "no-store");
    return checkinLimited;
  }

  const { data, error } = await supabase.rpc("check_in_ticket", { p_token: token }).single();

  if (error) {
    const code = error.message?.trim();

    // Surface the ticket's original check-in time so the scanner UI can show
    // "already checked in at HH:MM" instead of a bare error. mapRpcError()'s
    // {error, message} response shape has no room for this extra field, so
    // this one case is special-cased before falling through to it (see
    // lib/errors.ts for the RPC's use of `detail =` on this exception).
    if (code === "TICKET_ALREADY_CHECKED_IN") {
      return NextResponse.json(
        {
          error: code,
          message: "This ticket has already been checked in.",
          checkedInAt: error.details || null,
        },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }

    const mapped = mapRpcError(error);
    mapped.headers.set("Cache-Control", "no-store");
    return mapped;
  }

  if (!data) {
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Check-in failed unexpectedly." },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // Untyped Supabase client -> rpc().single() data is `{}`; cast to what
  // check_in_ticket() RETURNS (see 0012_checkin_dashboard.sql).
  const row = data as {
    ticket_id: string;
    serial_no: string;
    tier_name: string;
    attendee_email: string | null;
    checked_in_at: string;
  };

  return NextResponse.json(
    {
      ticketId: row.ticket_id,
      serialNo: row.serial_no,
      tierName: row.tier_name,
      attendeeEmail: row.attendee_email,
      checkedInAt: row.checked_in_at,
    },
    { headers: NO_STORE_HEADERS }
  );
}
