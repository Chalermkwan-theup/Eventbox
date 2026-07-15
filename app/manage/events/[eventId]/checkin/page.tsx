import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { CheckinScanner } from "@/components/checkin-scanner";

export const dynamic = "force-dynamic";

/**
 * Staff gate check-in shell. Real authorization happens inside
 * check_in_ticket() (supabase/migrations/0012_checkin_dashboard.sql) — a
 * signed-in non-staff user can still land on this page; they'll get a clear
 * "ไม่มีสิทธิ์" banner (NOT_EVENT_STAFF) from <CheckinScanner /> the first
 * time they try to scan, rather than a hard 404 that can't distinguish
 * "wrong event id" from "not staff for this event".
 */
export default async function CheckinPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  if (!uuidSchema.safeParse(eventId).success) {
    notFound();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/manage/events/${eventId}/checkin`)}`);
  }

  // event_select RLS lets staff see their org's events regardless of status;
  // a non-staff caller (or a bad id) gets null here — best-effort only, used
  // solely to put the event's name in the heading.
  const { data: event } = await supabase.from("event").select("id, name").eq("id", eventId).maybeSingle();

  return (
    <div className="container">
      <h1>เช็คอินหน้างาน{event?.name ? ` — ${event.name}` : ""}</h1>
      <CheckinScanner eventId={eventId} />
    </div>
  );
}
