import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { formatSatangToThb } from "@/lib/money";
import { PaymentPanel } from "@/components/payment-panel";

export const dynamic = "force-dynamic";

interface OrderItemRow {
  id: string;
  quantity: number;
  unit_price_satang: number;
  ticket_tier: { name: string } | { name: string }[] | null;
}

interface OrderRow {
  id: string;
  status: string;
  subtotal_satang: number;
  discount_satang: number;
  total_satang: number;
  expires_at: string;
  event_id: string;
  user_id: string;
  order_item: OrderItemRow[] | null;
}

export default async function CheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  if (!uuidSchema.safeParse(orderId).success) {
    notFound();
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/checkout/${orderId}`)}`);
  }

  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, status, subtotal_satang, discount_satang, total_satang, expires_at, event_id, user_id, order_item(id, quantity, unit_price_satang, ticket_tier(name))"
    )
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

  // orders_select RLS scopes rows to the owner (or org staff) already, but
  // this frontend never acts as staff — an id belonging to someone else
  // simply won't be returned by the query above, making this check mostly
  // defense-in-depth against a future RLS/policy change.
  if (!order || order.user_id !== user.id) {
    notFound();
  }

  if (order.status !== "pending_payment") {
    redirect(`/orders/${orderId}`);
  }

  const items = order.order_item ?? [];

  return (
    <div className="container container--narrow">
      <h1>ชำระเงิน</h1>

      <div className="card order-summary">
        <h2>สรุปคำสั่งซื้อ</h2>
        <ul className="order-summary__items">
          {items.map((item) => {
            const tier = Array.isArray(item.ticket_tier) ? item.ticket_tier[0] : item.ticket_tier;
            return (
              <li key={item.id}>
                <span>
                  {tier?.name ?? "ตั๋ว"} x {item.quantity}
                </span>
                <span>{formatSatangToThb(item.unit_price_satang * item.quantity)}</span>
              </li>
            );
          })}
        </ul>
        <div className="order-summary__row">
          <span>ยอดรวม</span>
          <span>{formatSatangToThb(order.subtotal_satang)}</span>
        </div>
        {order.discount_satang > 0 && (
          <div className="order-summary__row">
            <span>ส่วนลด</span>
            <span>-{formatSatangToThb(order.discount_satang)}</span>
          </div>
        )}
        <div className="order-summary__row order-summary__row--total">
          <span>ยอดชำระ</span>
          <span>{formatSatangToThb(order.total_satang)}</span>
        </div>
      </div>

      <PaymentPanel
        orderId={order.id}
        eventId={order.event_id}
        totalSatang={order.total_satang}
        expiresAt={order.expires_at}
        userEmail={user.email ?? null}
      />

      <p className="text-muted checkout-back-link">
        <Link href={`/events/${order.event_id}`}>กลับไปหน้ากิจกรรม</Link>
      </p>
    </div>
  );
}
