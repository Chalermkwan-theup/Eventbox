"use client";

import { useEffect } from "react";
import { useEventStats, type EventStatsTier } from "@/lib/hooks/use-event-stats";
import { createClient } from "@/lib/supabase/client";
import { formatSatangToThb, formatDateTimeBangkok } from "@/lib/money";
import { translateApiError } from "@/lib/api-error-messages";

interface EventDashboardProps {
  eventId: string;
}

function percent(rate: number): number {
  return Math.round(rate * 1000) / 10; // one decimal place, e.g. 0.4567 -> 45.7
}

function tierCheckedInPercent(tier: EventStatsTier): number {
  const denominator = tier.sold > 0 ? tier.sold : tier.quota;
  if (!denominator) return 0;
  return Math.min(100, Math.round((tier.checked_in / denominator) * 100));
}

/**
 * Organizer/staff dashboard for one event. Data flow:
 *   - useEventStats polls GET /api/events/:eventId/stats every 5s + on focus
 *     (aggregate polling, not a per-row subscription — see that hook's doc).
 *   - This component additionally subscribes to `orders` INSERT/UPDATE via
 *     the Realtime client, filtered to this event, and calls refresh()
 *     immediately when a row lands with status "paid" — so a fresh sale
 *     shows up well inside the 5s poll window instead of waiting for it.
 *     Supabase Realtime's `filter` option only supports a single column
 *     comparison per subscription (no compound `event_id=eq...&status=eq...`),
 *     so the status check happens client-side in the callback instead.
 */
export function EventDashboard({ eventId }: EventDashboardProps) {
  const { stats, loading, errorCode, lastUpdatedAt, refresh } = useEventStats(eventId);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`event-dashboard-orders-${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders", filter: `event_id=eq.${eventId}` },
        (payload) => {
          const row = payload.new as { status?: string } | null;
          if (row?.status === "paid") refresh();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `event_id=eq.${eventId}` },
        (payload) => {
          const row = payload.new as { status?: string } | null;
          if (row?.status === "paid") refresh();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId, refresh]);

  // Loading: no data at all yet (first fetch still in flight).
  if (loading && !stats) {
    return (
      <div className="dashboard" aria-hidden="true">
        <div className="stat-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card stat-card">
              <div className="skeleton skeleton-line skeleton-line--short" />
              <div className="skeleton skeleton-line skeleton-line--title" />
            </div>
          ))}
        </div>
        <div className="card">
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" />
        </div>
      </div>
    );
  }

  // Error: no data at all to fall back on.
  if (errorCode && !stats) {
    return (
      <div className="alert alert-error" role="alert">
        <p>{translateApiError(errorCode)}</p>
        <button type="button" className="btn btn-primary" onClick={refresh}>
          ลองใหม่อีกครั้ง
        </button>
      </div>
    );
  }

  if (!stats) {
    // Shouldn't normally happen (covered by the loading/error branches above)
    // but keeps the component exhaustive against its own state shape.
    return (
      <div className="empty-state">
        <p>ไม่มีข้อมูลให้แสดง</p>
      </div>
    );
  }

  const isEmpty = stats.totalTickets === 0 && stats.totalReserved === 0;
  const checkInPercent = percent(stats.checkInRate);

  return (
    <div className="dashboard">
      <div className="dashboard__refresh text-muted" role="status" aria-live="polite">
        {errorCode ? (
          <span>อัปเดตล่าสุดไม่สำเร็จ กำลังแสดงข้อมูลล่าสุดที่มี — ระบบจะลองใหม่อัตโนมัติ</span>
        ) : (
          <span>
            อัปเดตอัตโนมัติทุก 5 วินาที
            {lastUpdatedAt && ` · ล่าสุด ${formatDateTimeBangkok(new Date(lastUpdatedAt).toISOString())}`}
          </span>
        )}
      </div>

      {isEmpty && (
        <div className="empty-state">
          <p>ยังไม่มีการจองหรือขายตั๋วสำหรับกิจกรรมนี้</p>
        </div>
      )}

      <div className="stat-grid">
        <div className="card stat-card">
          <span className="stat-card__label">ลงทะเบียนแล้ว</span>
          <span className="stat-card__value">{stats.totalSold.toLocaleString("th-TH")}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">เช็คอินแล้ว</span>
          <span className="stat-card__value">{stats.checkedInCount.toLocaleString("th-TH")}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">รอชำระ/จอง</span>
          <span className="stat-card__value">{stats.totalReserved.toLocaleString("th-TH")}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">รายได้</span>
          <span className="stat-card__value">{formatSatangToThb(stats.revenueSatang)}</span>
        </div>
      </div>

      <div className="card">
        <h2>อัตราเช็คอิน</h2>
        <div className="progress-bar" role="progressbar" aria-valuenow={checkInPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar__fill" style={{ width: `${checkInPercent}%` }} />
        </div>
        <p className="text-muted">
          {stats.checkedInCount.toLocaleString("th-TH")} จาก {stats.totalTickets.toLocaleString("th-TH")} ใบ (
          {checkInPercent}%)
        </p>
      </div>

      <div className="card">
        <h2>แยกตามประเภทตั๋ว</h2>
        {stats.tierBreakdown.length === 0 ? (
          <p className="text-muted">ยังไม่มีประเภทตั๋วสำหรับกิจกรรมนี้</p>
        ) : (
          <div className="tier-table-wrap">
            <table className="tier-table">
              <thead>
                <tr>
                  <th scope="col">ประเภทตั๋ว</th>
                  <th scope="col">ขายแล้ว / โควต้า</th>
                  <th scope="col">เช็คอินแล้ว</th>
                </tr>
              </thead>
              <tbody>
                {stats.tierBreakdown.map((tier) => (
                  <tr key={tier.tier_id}>
                    <th scope="row">{tier.name}</th>
                    <td>
                      {tier.sold.toLocaleString("th-TH")} / {tier.quota.toLocaleString("th-TH")}
                    </td>
                    <td>
                      <div className="tier-table__checkin">
                        <span>{tier.checked_in.toLocaleString("th-TH")}</span>
                        <div className="progress-bar progress-bar--small">
                          <div
                            className="progress-bar__fill"
                            style={{ width: `${tierCheckedInPercent(tier)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
