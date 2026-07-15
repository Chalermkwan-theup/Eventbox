import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDateTimeBangkok } from "@/lib/money";

export const dynamic = "force-dynamic";

interface TicketRow {
  id: string;
  serial_no: string;
  status: "valid" | "checked_in" | "void";
  event_id: string;
  tier_id: string;
  created_at: string;
}

const STATUS_LABEL_TH: Record<TicketRow["status"], string> = {
  valid: "ใช้งานได้",
  checked_in: "เช็คอินแล้ว",
  void: "ยกเลิกแล้ว",
};

export default async function TicketsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/tickets")}`);
  }

  // ticket_view drops qr_secret (see 0002_functions_rls.sql) — never query the
  // base `ticket` table directly from the frontend.
  const { data, error } = await supabase
    .from("ticket_view")
    .select("id, serial_no, status, event_id, tier_id, created_at")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="container">
        <h1>ตั๋วของฉัน</h1>
        <div className="alert alert-error" role="alert">
          <p>โหลดตั๋วของคุณไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  const tickets = (data ?? []) as TicketRow[];

  if (tickets.length === 0) {
    return (
      <div className="container">
        <h1>ตั๋วของฉัน</h1>
        <div className="empty-state">
          <p>คุณยังไม่มีตั๋ว ไปเลือกซื้อตั๋วงานที่สนใจกันเลย</p>
          <Link href="/events" className="btn btn-primary">
            ดูกิจกรรมทั้งหมด
          </Link>
        </div>
      </div>
    );
  }

  // ticket_view is a plain view (no FK constraints of its own), so PostgREST
  // can't embed event/ticket_tier automatically — batch-fetch both separately
  // and merge in JS instead of one query per ticket.
  const eventIds = Array.from(new Set(tickets.map((t) => t.event_id)));
  const tierIds = Array.from(new Set(tickets.map((t) => t.tier_id)));

  const [{ data: events }, { data: tiersData }] = await Promise.all([
    supabase.from("event").select("id, name, starts_at, venue").in("id", eventIds),
    supabase.from("ticket_tier").select("id, name").in("id", tierIds),
  ]);

  const eventById = new Map((events ?? []).map((e) => [e.id, e]));
  const tierById = new Map((tiersData ?? []).map((t) => [t.id, t]));

  return (
    <div className="container">
      <h1>ตั๋วของฉัน</h1>
      <ul className="ticket-list">
        {tickets.map((ticket) => {
          const event = eventById.get(ticket.event_id);
          const tier = tierById.get(ticket.tier_id);
          return (
            <li key={ticket.id} className="ticket-list__item">
              <Link href={`/tickets/${ticket.id}`}>
                <h2>{event?.name ?? "กิจกรรม"}</h2>
                {tier?.name && <p className="text-muted">{tier.name}</p>}
                {event?.starts_at && <p>{formatDateTimeBangkok(event.starts_at)}</p>}
                <p>เลขที่ตั๋ว {ticket.serial_no}</p>
                <span className={`badge badge--status-${ticket.status}`}>{STATUS_LABEL_TH[ticket.status]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
