import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDateTimeBangkok } from "@/lib/money";

export const dynamic = "force-dynamic";

interface EventListRow {
  id: string;
  name: string;
  venue: string | null;
  starts_at: string;
}

export default async function EventsPage() {
  const supabase = await createClient();

  // event_select_public RLS already scopes anon/authenticated callers to
  // status = 'published' rows, but filtering explicitly keeps this query
  // correct even if a signed-in org member happens to view this public page.
  const { data, error } = await supabase
    .from("event")
    .select("id, name, venue, starts_at")
    .eq("status", "published")
    .order("starts_at", { ascending: true });

  if (error) {
    return (
      <div className="container">
        <h1>กิจกรรมที่เปิดขาย</h1>
        <div className="alert alert-error" role="alert">
          <p>โหลดรายการกิจกรรมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  const events = (data ?? []) as EventListRow[];

  if (events.length === 0) {
    return (
      <div className="container">
        <h1>กิจกรรมที่เปิดขาย</h1>
        <div className="empty-state">
          <p>ยังไม่มีกิจกรรมที่เปิดขายตั๋วในตอนนี้ กลับมาดูใหม่อีกครั้งนะ</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>กิจกรรมที่เปิดขาย</h1>
      <ul className="event-grid">
        {events.map((event) => (
          <li key={event.id} className="event-card">
            <Link href={`/events/${event.id}`} className="event-card__link">
              <h2>{event.name}</h2>
              {event.venue && <p className="text-muted">{event.venue}</p>}
              <p className="event-card__date">{formatDateTimeBangkok(event.starts_at)}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
