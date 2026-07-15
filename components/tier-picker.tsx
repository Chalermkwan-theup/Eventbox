"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAvailability, type TierAvailability } from "@/lib/hooks/use-availability";
import { AvailabilityBadge } from "@/components/availability-badge";
import { formatSatangToThb } from "@/lib/money";
import { translateApiError } from "@/lib/api-error-messages";

export interface InitialTier extends TierAvailability {
  perUserLimit: number | null;
}

interface TierPickerProps {
  eventId: string;
  initialTiers: InitialTier[];
}

type WaitlistState = "idle" | "joining" | "joined" | "error";

// Mirrors the per-item cap in reserveTicketsSchema (lib/validation.ts) —
// keeping the client-side max in sync avoids a round trip just to learn
// "quantity too high" for an obviously-too-high value.
const MAX_QTY_PER_ITEM = 20;

/**
 * Ticket tier selector + reserve action for an event detail page.
 * - Live "remaining" counts come from useAvailability (polls every 10s + on
 *   focus); per-tier limits are static, seeded once from the SSR fetch.
 * - On SOLD_OUT from the reserve call, we don't get told which tier caused it
 *   (the RPC error is generic) — so we cross-reference the items we *tried*
 *   to reserve against the latest known availability and offer the waitlist
 *   button for every tier whose selected quantity now exceeds its remaining
 *   stock (falling back to "all selected tiers" if that comes up empty, e.g.
 *   availability hadn't updated yet).
 */
export function TierPicker({ eventId, initialTiers }: TierPickerProps) {
  const router = useRouter();

  const limitsByTier = useMemo(
    () => new Map(initialTiers.map((t) => [t.tierId, t.perUserLimit])),
    [initialTiers]
  );

  const { tiers, error: availabilityError, refresh } = useAvailability(
    eventId,
    initialTiers.map(({ tierId, name, remaining, priceSatang }) => ({ tierId, name, remaining, priceSatang }))
  );

  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [promoCode, setPromoCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [soldOutTierIds, setSoldOutTierIds] = useState<Set<string>>(new Set());
  const [waitlistState, setWaitlistState] = useState<Record<string, WaitlistState>>({});

  function maxAllowedFor(tierId: string, remaining: number): number {
    const perUserLimit = limitsByTier.get(tierId);
    const cap = perUserLimit != null ? Math.min(perUserLimit, MAX_QTY_PER_ITEM) : MAX_QTY_PER_ITEM;
    return Math.max(0, Math.min(remaining, cap));
  }

  function handleQtyChange(tierId: string, remaining: number, rawValue: number) {
    const max = maxAllowedFor(tierId, remaining);
    const clamped = Number.isFinite(rawValue) ? Math.max(0, Math.min(Math.trunc(rawValue), max)) : 0;
    setQuantities((prev) => ({ ...prev, [tierId]: clamped }));
  }

  // Sold-out tiers (either remaining hit 0 via the availability poll, or the
  // reserve call just came back SOLD_OUT for them) must not contribute to the
  // total — otherwise their stale quantity keeps the reserve button enabled and
  // a retry re-submits the same doomed tier, looping on SOLD_OUT.
  const estimatedTotalSatang = tiers.reduce((sum, tier) => {
    if (tier.remaining <= 0 || soldOutTierIds.has(tier.tierId)) return sum;
    return sum + (quantities[tier.tierId] ?? 0) * tier.priceSatang;
  }, 0);

  async function handleReserve() {
    setFormError(null);
    setSoldOutTierIds(new Set());

    const items = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([tierId, quantity]) => ({ tierId, quantity }));

    if (items.length === 0) {
      setFormError("กรุณาเลือกจำนวนตั๋วอย่างน้อย 1 ใบ");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/checkout/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          items,
          promoCode: promoCode.trim() ? promoCode.trim() : undefined,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        if (body.error === "UNAUTHENTICATED") {
          router.push(`/login?next=${encodeURIComponent(`/events/${eventId}`)}`);
          return;
        }

        if (body.error === "SOLD_OUT") {
          const affected = new Set(
            items
              .filter((item) => {
                const live = tiers.find((t) => t.tierId === item.tierId);
                return live ? live.remaining < item.quantity : true;
              })
              .map((item) => item.tierId)
          );
          const finalAffected = affected.size > 0 ? affected : new Set(items.map((i) => i.tierId));
          setSoldOutTierIds(finalAffected);
          // Drop the selected quantity for the sold-out tiers so the summary
          // total and the reserve button reflect reality and can't re-submit them.
          setQuantities((prev) => {
            const nextQ = { ...prev };
            for (const id of finalAffected) delete nextQ[id];
            return nextQ;
          });
          refresh();
        }

        setFormError(translateApiError(body.error));
        return;
      }

      router.push(`/checkout/${body.orderId}`);
    } catch {
      setFormError(translateApiError(undefined));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleJoinWaitlist(tierId: string) {
    setWaitlistState((prev) => ({ ...prev, [tierId]: "joining" }));
    try {
      const res = await fetch("/api/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, tierId }),
      });
      const body = await res.json();

      if (!res.ok && body.error !== "ALREADY_ON_WAITLIST") {
        setWaitlistState((prev) => ({ ...prev, [tierId]: "error" }));
        return;
      }

      setWaitlistState((prev) => ({ ...prev, [tierId]: "joined" }));
    } catch {
      setWaitlistState((prev) => ({ ...prev, [tierId]: "error" }));
    }
  }

  return (
    <div className="tier-picker card">
      <h2>เลือกประเภทตั๋ว</h2>

      {availabilityError && (
        <p className="text-muted tier-picker__availability-warning" role="status">
          ไม่สามารถอัปเดตจำนวนที่เหลือล่าสุดได้ ตัวเลขที่แสดงอาจไม่ใช่ปัจจุบันที่สุด
        </p>
      )}

      <ul className="tier-picker__list">
        {tiers.map((tier) => {
          const remaining = tier.remaining;
          const isSoldOut = remaining <= 0;
          const max = maxAllowedFor(tier.tierId, remaining);
          const qty = quantities[tier.tierId] ?? 0;
          const showWaitlistOffer = isSoldOut || soldOutTierIds.has(tier.tierId);
          const wlState = waitlistState[tier.tierId] ?? "idle";

          return (
            <li key={tier.tierId} className="tier-picker__row">
              <div className="tier-picker__info">
                <span className="tier-picker__name">{tier.name}</span>
                <span className="tier-picker__price">{formatSatangToThb(tier.priceSatang)}</span>
                <AvailabilityBadge remaining={remaining} />
              </div>

              {showWaitlistOffer ? (
                <div className="tier-picker__waitlist">
                  {wlState === "joined" ? (
                    <p className="text-muted">คุณอยู่ในคิวรอตั๋วประเภทนี้แล้ว</p>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleJoinWaitlist(tier.tierId)}
                      disabled={wlState === "joining"}
                    >
                      {wlState === "joining" ? "กำลังลงชื่อ..." : "ลงชื่อรอคิว (waitlist)"}
                    </button>
                  )}
                  {wlState === "error" && <p className="form-error">ลงชื่อรอคิวไม่สำเร็จ กรุณาลองใหม่</p>}
                </div>
              ) : (
                <div className="tier-picker__qty">
                  <label htmlFor={`qty-${tier.tierId}`} className="sr-only">
                    จำนวนตั๋ว {tier.name}
                  </label>
                  <button
                    type="button"
                    className="qty-btn"
                    aria-label={`ลดจำนวน ${tier.name}`}
                    onClick={() => handleQtyChange(tier.tierId, remaining, qty - 1)}
                    disabled={qty <= 0}
                  >
                    -
                  </button>
                  <input
                    id={`qty-${tier.tierId}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={max}
                    value={qty}
                    onChange={(e) => handleQtyChange(tier.tierId, remaining, Number(e.target.value))}
                  />
                  <button
                    type="button"
                    className="qty-btn"
                    aria-label={`เพิ่มจำนวน ${tier.name}`}
                    onClick={() => handleQtyChange(tier.tierId, remaining, qty + 1)}
                    disabled={qty >= max}
                  >
                    +
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="tier-picker__promo">
        <label htmlFor="promo-code">โค้ดส่วนลด (ถ้ามี)</label>
        <input
          id="promo-code"
          type="text"
          value={promoCode}
          onChange={(e) => setPromoCode(e.target.value)}
          placeholder="กรอกโค้ดส่วนลด"
        />
      </div>

      <div className="tier-picker__summary">
        <span>ยอดรวมโดยประมาณ</span>
        <strong>{formatSatangToThb(estimatedTotalSatang)}</strong>
      </div>

      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}

      <button
        type="button"
        className="btn btn-primary tier-picker__submit"
        onClick={handleReserve}
        disabled={submitting || estimatedTotalSatang <= 0}
      >
        {submitting ? "กำลังจองตั๋ว..." : "จองตั๋วและไปชำระเงิน"}
      </button>
    </div>
  );
}
