"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface TierAvailability {
  tierId: string;
  name: string;
  remaining: number;
  priceSatang: number;
}

interface AvailabilityResponse {
  tiers: TierAvailability[];
}

interface UseAvailabilityResult {
  tiers: TierAvailability[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 10000;

/**
 * Polls GET /api/events/:eventId/availability (CDN-cached 5s server-side, see
 * that route) every 10s and again on window focus, per architect's spec.
 * `initialTiers` should be the SSR snapshot the event page already fetched —
 * used as the seed so the picker renders instantly instead of blank, and kept
 * as a fallback if a poll ever errors (never blow away last-known-good data).
 */
export function useAvailability(eventId: string, initialTiers: TierAvailability[]): UseAvailabilityResult {
  const [tiers, setTiers] = useState<TierAvailability[]>(initialTiers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);

    try {
      const res = await fetch(`/api/events/${eventId}/availability`, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`availability request failed (${res.status})`);
      }
      const body = (await res.json()) as AvailabilityResponse;
      setTiers(body.tiers);
      setError(null);
    } catch (err) {
      // Deliberately keep the previous `tiers` value on error — showing a
      // stale-but-plausible remaining count is safer UX than blanking the
      // picker out from under someone mid-selection.
      setError(err instanceof Error ? err.message : "Failed to load availability");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { tiers, loading, error, refresh };
}
