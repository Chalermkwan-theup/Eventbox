import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { formatSatangToThb } from "@/lib/money";

export const dynamic = "force-dynamic";

interface OrderRow {
  id: string;
  status: string;
  total_satang: number;
  event_id: string;
  user_id: string;
  order_item: { id: string }[] | null;
}

interface TicketRow {
  id: string;
  serial_no: string;
}

export default async function OrderResultPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  if (!uuidSchema.safeParse(orderId).success) {
    notFound();
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/orders/${orderId}`)}`);
  }

  const { data, error } = await supabase
    .from("orders")
    .select("id, status, total_satang, event_id, user_id, order_item(id)")
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    return (
      <div className="container container--narrow">
        <div className="alert alert-error" role="alert">
          <p>โหลดคำสั่งซื้อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  const order = data as OrderRow | null;

  if (!order || order.user_id !== user.id) {
    notFound();
  }

  if (order.status === "pending_payment") {
    redirect(`/checkout/${orderId}`);
  }

  if (order.status === "paid") {
    const orderItemIds = (order.order_item ?? []).map((item) => item.id);

    const { data: ticketData } = orderItemIds.length
      ? await supabase.from("ticket_view").select("id, serial_no").in("order_item_id", orderItemIds)
      : { data: [] as TicketRow[] };

    const tickets = (ticketData ?? []) as TicketRow[];

    return (
      <div className="container container--narrow">
        <div className="card">
          <h1>ชำระเงินสำเร็จ</h1>
          <p>ขอบคุณสำหรับการสั่งซื้อ ยอดชำระ {formatSatangToThb(order.total_satang)}</p>
          {tickets.length > 0 ? (
            <ul className="order-result__tickets">
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link href={`/tickets/${ticket.id}`}>ตั๋วเลขที่ {ticket.serial_no}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">กำลังออกตั๋ว กรุณารีเฟรชหน้านี้อีกครั้งในไม่กี่วินาที</p>
          )}
          <Link href="/tickets" className="btn btn-primary">
            ดูตั๋วทั้งหมดของฉัน
          </Link>
        </div>
      </div>
    );
  }

  if (order.status === "refunded") {
    return (
      <div className="container container--narrow">
        <div className="card">
          <h1>คืนเงินแล้ว</h1>
          <p>คำสั่งซื้อนี้ถูกคืนเงินจำนวน {formatSatangToThb(order.total_satang)} เรียบร้อยแล้ว</p>
          <Link href="/events" className="btn btn-primary">
            ดูกิจกรรมอื่น
          </Link>
        </div>
      </div>
    );
  }

  // expired | cancelled
  return (
    <div className="container container--narrow">
      <div className="card">
        <h1>{order.status === "expired" ? "หมดเวลาชำระเงิน" : "คำสั่งซื้อถูกยกเลิก"}</h1>
        <p>คำสั่งซื้อนี้ไม่ได้รับการชำระเงินและที่นั่งถูกปล่อยคืนแล้ว</p>
        <Link href={`/events/${order.event_id}`} className="btn btn-primary">
          ซื้อตั๋วใหม่
        </Link>
      </div>
    </div>
  );
}
