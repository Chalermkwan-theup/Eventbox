import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { formatDateTimeBangkok } from "@/lib/money";
import { TierPicker, type InitialTier } from "@/components/tier-picker";

export const dynamic = "force-dynamic";

interface TierRow {
  id: string;
  name: string;
  price_satang: number;
  per_user_limit: number | null;
  sort_order: number;
  tier_inventory:
    | { quota: number; reserved: number; sold: number }
    | { quota: number; reserved: number; sold: number }[]
    | null;
}

export default async function EventDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;

  if (!uuidSchema.safeParse(eventId).success) {
    notFound();
  }

  const supabase = await createClient();

  // event_select_public RLS returns null for draft/cancelled events to a
  // public caller — indistinguishable from "doesn't exist", which is fine
  // here: both should render as 404.
  const { data: event, error: eventError } = await supabase
    .from("event")
    .select("id, name, description, venue, starts_at, ends_at, status")
    .eq("id", eventId)
    .eq("status", "published")
    .maybeSingle();

  if (eventError) {
    return (
      <div className="container">
        <div className="alert alert-error" role="alert">
          <p>โหลดข้อมูลกิจกรรมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  if (!event) {
    notFound();
  }

  const { data: tierData, error: tiersError } = await supabase
    .from("ticket_tier")
    .select("id, name, price_satang, per_user_limit, sort_order, tier_inventory(quota, reserved, sold)")
    .eq("event_id", eventId)
    .order("sort_order", { ascending: true });

  if (tiersError) {
    return (
      <div className="container">
        <div className="alert alert-error" role="alert">
          <p>โหลดประเภทตั๋วไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
        </div>
      </div>
    );
  }

  const tiers = (tierData ?? []) as TierRow[];

  const initialTiers: InitialTier[] = tiers.map((tier) => {
    const inventory = Array.isArray(tier.tier_inventory) ? tier.tier_inventory[0] : tier.tier_inventory;
    const remaining = inventory ? Math.max(inventory.quota - inventory.reserved - inventory.sold, 0) : 0;
    return {
      tierId: tier.id,
      name: tier.name,
      remaining,
      priceSatang: tier.price_satang,
      perUserLimit: tier.per_user_limit,
    };
  });

  return (
    <div className="container">
      <article className="event-detail card">
        <h1>{event.name}</h1>
        {event.venue && <p className="text-muted">{event.venue}</p>}
        <p className="event-detail__date">
          {formatDateTimeBangkok(event.starts_at)} - {formatDateTimeBangkok(event.ends_at)}
        </p>
        {event.description && <p className="event-detail__description">{event.description}</p>}
      </article>

      {initialTiers.length === 0 ? (
        <div className="empty-state">
          <p>ยังไม่มีประเภทตั๋วเปิดขายสำหรับกิจกรรมนี้</p>
        </div>
      ) : (
        <TierPicker eventId={event.id} initialTiers={initialTiers} />
      )}
    </div>
  );
}
