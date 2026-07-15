"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { translateApiError } from "@/lib/api-error-messages";

interface TicketQRProps {
  ticketId: string;
}

interface QrResponse {
  token: string;
  serialNo: string;
  status: "valid" | "checked_in" | "void";
}

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "success"; data: QrResponse };

/**
 * Fetches GET /api/tickets/:ticketId/qr and renders the token as a QR code.
 * The token is deterministically derived from ticket id + qr_secret
 * server-side (see issue_ticket_qr_token in
 * supabase/migrations/0011_phase3_qr_realtime.sql) — re-fetching always
 * yields the same token for a still-valid ticket, so this only fetches once
 * on mount plus on manual refresh (e.g. to pick up a status change like
 * check-in without a full page reload). Response is `no-store` server-side.
 */
export function TicketQR({ ticketId }: TicketQRProps) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/tickets/${ticketId}/qr`, { cache: "no-store" });
      const body = await res.json();

      if (!res.ok) {
        setState({ phase: "error", message: translateApiError(body.error) });
        return;
      }

      setState({ phase: "success", data: body as QrResponse });
    } catch {
      setState({ phase: "error", message: "โหลด QR ตั๋วไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="ticket-qr" role="status" aria-live="polite">
        <div className="skeleton skeleton-qr" />
        <p>กำลังโหลด QR ตั๋ว...</p>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="alert alert-error" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn btn-primary" onClick={load}>
          ลองใหม่อีกครั้ง
        </button>
      </div>
    );
  }

  const { data } = state;

  if (data.status !== "valid") {
    return (
      <div className="alert alert-warning" role="alert">
        <p>
          ตั๋วใบนี้{data.status === "checked_in" ? "เช็คอินไปแล้ว" : "ถูกยกเลิกการใช้งานแล้ว"} (เลขที่ตั๋ว{" "}
          {data.serialNo})
        </p>
      </div>
    );
  }

  return (
    <div className="ticket-qr">
      <div className="ticket-qr__code">
        <QRCodeSVG value={data.token} size={240} marginSize={2} />
      </div>
      <p className="ticket-qr__serial">เลขที่ตั๋ว {data.serialNo}</p>
      <button type="button" className="btn btn-ghost" onClick={load}>
        รีเฟรช QR
      </button>
    </div>
  );
}
