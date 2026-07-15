import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { formatDateTimeBangkok } from "@/lib/money";
import { TicketQR } from "@/components/ticket-qr";

export const dynamic = "force-dynamic";

interface TicketRow {
  id: string;
  serial_no: string;
  status: "valid" | "checked_in" | "void";
  event_id: string;
  tier_id: string;
  owner_user_id: string;
}

export default async function TicketDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;

  if (!uuidSchema.safeParse(ticketId).success) {
    notFound();
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/tickets/${ticketId}`)}`);
  }

  const { data, error } = await supabase
    .from("ticket_view")
    .select("id, serial_no, status, event_id, tier_id, owner_user_id")
    .eq("id", ticketId)
    .maybeSingle();

  if (error) {
    return (
      <div className="container container--narrow">
        <div className="alert alert-error" role="alert">
          <p>โหลดตั๋วไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  const ticket = data as TicketRow | null;

  // ticket_select RLS would already keep someone else's ticket from coming
  // back here at all — this check is defense-in-depth, matching the pattern
  // used in app/checkout/[orderId]/page.tsx.
  if (!ticket || ticket.owner_user_id !== user.id) {
    notFound();
  }

  const [{ data: event }, { data: tier }] = await Promise.all([
    supabase.from("event").select("name, venue, starts_at").eq("id", ticket.event_id).maybeSingle(),
    supabase.from("ticket_tier").select("name").eq("id", ticket.tier_id).maybeSingle(),
  ]);

  return (
    <div className="container container--narrow">
      <div className="card ticket-detail">
        <h1>{event?.name ?? "ตั๋ว"}</h1>
        {event?.venue && <p className="text-muted">{event.venue}</p>}
        {event?.starts_at && <p>{formatDateTimeBangkok(event.starts_at)}</p>}
        {tier?.name && <p className="ticket-detail__tier">{tier.name}</p>}

        <TicketQR ticketId={ticket.id} />

        <Link href="/tickets" className="btn btn-ghost">
          กลับไปตั๋วทั้งหมด
        </Link>
      </div>
    </div>
  );
}
