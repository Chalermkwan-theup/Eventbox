import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { mapRpcError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/tickets/:ticketId/qr
 * Issues a fresh QR token ('TKT1.<id>.<hmac>') for the caller's own valid
 * ticket. Nothing is persisted server-side for this — see
 * issue_ticket_qr_token() in supabase/migrations/0011_phase3_qr_realtime.sql
 * for the HMAC derivation (and that file's tail comment for the Phase 4
 * check-in/verify story). Never cached: the token, serial and status can all
 * change between requests (check-in, void), so every response is no-store.
 */
export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;

  const idCheck = uuidSchema.safeParse(ticketId);
  if (!idCheck.success) {
    return NextResponse.json(
      { error: "INVALID_TICKET_ID", message: "Malformed ticket id." },
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

  const qrLimited = await enforceRateLimit(supabase, `qr:${user.id}`, RATE_LIMITS.QR.max, RATE_LIMITS.QR.windowSeconds);
  if (qrLimited) {
    qrLimited.headers.set("Cache-Control", "no-store");
    return qrLimited;
  }

  const { data: token, error } = await supabase.rpc("issue_ticket_qr_token", {
    p_ticket_id: ticketId,
  });

  if (error) {
    const mapped = mapRpcError(error);
    mapped.headers.set("Cache-Control", "no-store");
    return mapped;
  }

  if (!token) {
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Could not issue QR token." },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  // ticket_view drops qr_secret (see 0002) and is still governed by
  // ticket_select RLS — the RPC above already proved ownership + valid
  // status; this is only to surface serialNo/status alongside the token
  // without a second privileged lookup path.
  const { data: ticket, error: ticketError } = await supabase
    .from("ticket_view")
    .select("serial_no, status")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError || !ticket) {
    console.error("Failed to load ticket_view after issuing QR token", ticketError);
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message: "Could not load ticket details." },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }

  return NextResponse.json(
    { token, serialNo: ticket.serial_no, status: ticket.status },
    { headers: NO_STORE_HEADERS }
  );
}
