"use client";

import { useEffect, useState } from "react";

interface CountdownProps {
  expiresAt: string;
  onExpire?: () => void;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Ticks down to `expiresAt` (order.expires_at) using the browser's own clock.
 * The server (internal_release_order, run via pg_cron) is the real source of
 * truth for when a hold actually expires — this is a best-effort UI countdown
 * that assumes client/server clock skew is small. Fires `onExpire` exactly
 * once when it reaches zero; the caller decides what to do (PaymentPanel
 * hides the QR and shows "buy again").
 */
export function Countdown({ expiresAt, onExpire }: CountdownProps) {
  const target = new Date(expiresAt).getTime();
  const [remainingMs, setRemainingMs] = useState(() => target - Date.now());
  const [hasFired, setHasFired] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setRemainingMs(target - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [target]);

  useEffect(() => {
    if (remainingMs <= 0 && !hasFired) {
      setHasFired(true);
      onExpire?.();
    }
  }, [remainingMs, hasFired, onExpire]);

  if (remainingMs <= 0) {
    return (
      <p className="countdown countdown--expired" role="timer">
        หมดเวลาชำระเงิน
      </p>
    );
  }

  return (
    <p className="countdown" role="timer" aria-live="polite">
      เหลือเวลาชำระเงินอีก <strong>{formatRemaining(remainingMs)}</strong> นาที
    </p>
  );
}
