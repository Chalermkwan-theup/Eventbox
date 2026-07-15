"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One row of `tierBreakdown` in the GET /api/events/:eventId/stats response.
 *
 * NOTE the inconsistent casing vs. the rest of the payload: the outer object
 * is camelCased by the route handler (see app/api/events/[eventId]/stats/route.ts),
 * but `tierBreakdown` itself is the raw `jsonb_agg(jsonb_build_object(...))`
 * value built inside event_checkin_stats() (supabase/migrations/0012_checkin_dashboard.sql)
 * and passed straight through unmodified — so each item's keys are still
 * snake_case exactly as the SQL wrote them. Verify against that migration /
 * route if either side ever changes.
 */
export interface EventStatsTier {
  tier_id: string;
  name: string;
  quota: number;
  sold: number;
  checked_in: number;
}

export interface EventStats {
  totalTickets: number;
  checkedInCount: number;
  /** 0..1 — multiply by 100 for a percentage. */
  checkInRate: number;
  totalReserved: number;
  totalSold: number;
  revenueSatang: number;
  tierBreakdown: EventStatsTier[];
}

interface UseEventStatsResult {
  stats: EventStats | null;
  loading: boolean;
  /** Raw API error code (translate with lib/api-error-messages.ts), not a message. */
  errorCode: string | null;
  /** Epoch ms of the last successful fetch, or null before the first one lands. */
  lastUpdatedAt: number | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Polls GET /api/events/:eventId/stats (always `no-store` server-side) every
 * 5s and again on window focus — the same aggregate-polling shape as
 * lib/hooks/use-availability.ts, deliberately not a Realtime subscription on
 * a hot row: the dashboard needs an aggregate across many tickets/orders, not
 * a single row's change stream. components/event-dashboard.tsx additionally
 * subscribes to `orders` INSERT/UPDATE via lib/supabase/client to call
 * `refresh()` immediately when a payment lands, instead of waiting up to 5s.
 *
 * On error, the previous `stats` value is kept (never blown away by a failed
 * poll) — same reasoning as useAvailability: a stale-but-plausible dashboard
 * is safer/less jarring than one that blanks out on a transient network blip.
 */
export function useEventStats(eventId: string): UseEventStatsResult {
  const [stats, setStats] = useState<EventStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const res = await fetch(`/api/events/${eventId}/stats`, { cache: "no-store" });
      const body = await res.json();

      if (!res.ok) {
        setErrorCode(typeof body?.error === "string" ? body.error : "INTERNAL_ERROR");
        return;
      }

      setStats(body as EventStats);
      setErrorCode(null);
      setLastUpdatedAt(Date.now());
    } catch {
      setErrorCode("NETWORK_ERROR");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { stats, loading, errorCode, lastUpdatedAt, refresh };
}
