"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type OrderStatus = "pending_payment" | "paid" | "cancelled" | "expired" | "refunded";

export interface OrderStatusSnapshot {
  status: OrderStatus;
  totalSatang: number;
  expiresAt: string;
}

interface UseOrderStatusResult {
  data: OrderStatusSnapshot | null;
  loading: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Watches a single order's status: Supabase Realtime (fast path, see
 * `alter publication supabase_realtime add table orders` in
 * supabase/migrations/0011_phase3_qr_realtime.sql) plus a 5s poll fallback
 * (architect's explicit requirement — also covers networks that block
 * websockets, where Realtime silently never connects). Both paths write to
 * the same state; whichever observes a change first wins. RLS (orders_select)
 * scopes the underlying row to its owner, same as the server-side fetch.
 *
 * `initial` should be the order snapshot the owning Server Component already
 * fetched, so the UI never shows a loading spinner for data it already has.
 */
export function useOrderStatus(orderId: string, initial?: OrderStatusSnapshot): UseOrderStatusResult {
  const [data, setData] = useState<OrderStatusSnapshot | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = createClient();

    async function fetchOnce() {
      const { data: row, error: fetchError } = await supabase
        .from("orders")
        .select("status, total_satang, expires_at")
        .eq("id", orderId)
        .maybeSingle();

      if (!mountedRef.current) return;

      if (fetchError) {
        setError(fetchError.message);
        setLoading(false);
        return;
      }

      if (row) {
        setData({
          status: row.status as OrderStatus,
          totalSatang: row.total_satang,
          expiresAt: row.expires_at,
        });
        setError(null);
      }
      setLoading(false);
    }

    fetchOnce();
    const interval = setInterval(fetchOnce, POLL_INTERVAL_MS);

    const channel = supabase
      .channel(`order-status-${orderId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
        (payload) => {
          if (!mountedRef.current) return;
          const row = payload.new as { status: OrderStatus; total_satang: number; expires_at: string };
          setData({ status: row.status, totalSatang: row.total_satang, expiresAt: row.expires_at });
          setError(null);
          setLoading(false);
        }
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  return { data, loading, error };
}
