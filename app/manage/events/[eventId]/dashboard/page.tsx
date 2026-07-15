import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { EventDashboard } from "@/components/event-dashboard";

export const dynamic = "force-dynamic";

/**
 * Organizer dashboard shell. Same auth-visibility caveat as the check-in
 * page: real authorization is enforced inside event_checkin_stats() (see
 * supabase/migrations/0012_checkin_dashboard.sql) via GET
 * /api/events/:eventId/stats, not here — a non-staff signed-in user landing
 * here sees a clear "ไม่มีสิทธิ์" error from <EventDashboard /> instead of a
 * hard 404.
 */
export default async function EventDashboardPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  if (!uuidSchema.safeParse(eventId).success) {
    notFound();
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/manage/events/${eventId}/dashboard`)}`);
  }

  const { data: event } = await supabase.from("event").select("id, name").eq("id", eventId).maybeSingle();

  return (
    <div className="container container--wide">
      <h1>แดชบอร์ดกิจกรรม{event?.name ? ` — ${event.name}` : ""}</h1>
      <EventDashboard eventId={eventId} />
    </div>
  );
}
