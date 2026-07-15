"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { translateApiError } from "@/lib/api-error-messages";
import { formatDateTimeBangkok } from "@/lib/money";

interface CheckinScannerProps {
  eventId: string;
}

interface CheckinSuccessBody {
  ticketId: string;
  serialNo: string;
  tierName: string;
  attendeeEmail: string;
  checkedInAt: string;
}

type ResultBanner =
  | { kind: "success"; data: CheckinSuccessBody }
  | { kind: "already"; checkedInAt: string | null }
  | { kind: "invalid" }
  | { kind: "void" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

type CameraState =
  | "idle" // not attempted yet (first paint, before the mount effect runs)
  | "starting"
  | "active"
  | "denied" // getUserMedia permission explicitly refused
  | "unsupported" // no camera / insecure context / browser lacks mediaDevices
  | "error"; // camera existed but html5-qrcode failed to start it

const SCANNER_ELEMENT_ID = "checkin-qr-reader";
// Ignore a re-scan of the *same* token within this window — a phone camera
// re-decodes the same QR code many times a second while it's in frame, and
// without this we'd fire duplicate POST /api/checkin requests (and duplicate
// vibrate/tone feedback) for one physical scan.
const DUPLICATE_TOKEN_COOLDOWN_MS = 3000;

function vibrate(pattern: number | number[]) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration is a nice-to-have, not load-bearing for the check-in flow.
  }
}

/** Short beep via Web Audio — avoids shipping/loading an audio asset file. */
function playTone(frequency: number, durationMs: number) {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + durationMs / 1000);
    oscillator.onended = () => ctx.close();
  } catch {
    // Autoplay-policy or unsupported-browser failures are fine to swallow —
    // sound is a supplementary cue, the on-screen banner is authoritative.
  }
}

function classifyResponse(body: Record<string, unknown>): ResultBanner {
  const code = typeof body.error === "string" ? body.error : undefined;

  if (code === "TICKET_ALREADY_CHECKED_IN") {
    return {
      kind: "already",
      checkedInAt: typeof body.checkedInAt === "string" ? body.checkedInAt : null,
    };
  }
  if (code === "TICKET_VOID") return { kind: "void" };
  if (code === "TICKET_NOT_FOUND") return { kind: "not_found" };
  if (code === "NOT_EVENT_STAFF") return { kind: "forbidden" };
  if (code === "INVALID_TOKEN" || code === "VALIDATION_ERROR") return { kind: "invalid" };
  return { kind: "error", message: translateApiError(code) };
}

/**
 * Gate check-in scanner (staff-facing, mobile-first). Two input paths feed
 * the same `submitToken`: the live camera (html5-qrcode) and a manual text
 * fallback, because gate hardware/lighting/camera permissions fail often
 * enough in practice that manual entry can't be an afterthought.
 *
 * html5-qrcode is dynamically imported inside the mount effect (not a static
 * top-level import) because this is a Client Component that Next.js still
 * server-renders once for the initial HTML — a browser-only library touching
 * `navigator`/`window` at module scope would break that SSR pass.
 */
// `eventId` is accepted (and required in the props type) for symmetry with
// the page route it's mounted from, even though it isn't referenced in the
// body below — check_in_ticket() derives the event from the scanned ticket
// itself (see supabase/migrations/0012_checkin_dashboard.sql), not from this
// prop. Kept for a possible future multi-event kiosk mode.
export function CheckinScanner({ eventId: _eventId }: CheckinScannerProps) {
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ResultBanner | null>(null);
  const [sessionCount, setSessionCount] = useState(0);

  const scannerInstanceRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const lastTokenRef = useRef<string | null>(null);
  const lastScanAtRef = useRef(0);
  const inFlightRef = useRef(false);

  const submitToken = useCallback(async (rawToken: string) => {
    const token = rawToken.trim();
    if (!token) return;

    if (inFlightRef.current) return;

    const now = Date.now();
    if (lastTokenRef.current === token && now - lastScanAtRef.current < DUPLICATE_TOKEN_COOLDOWN_MS) {
      return;
    }
    lastTokenRef.current = token;
    lastScanAtRef.current = now;

    inFlightRef.current = true;
    setSubmitting(true);
    setResult(null);

    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();

      if (res.ok) {
        setResult({ kind: "success", data: body as CheckinSuccessBody });
        setSessionCount((count) => count + 1);
        vibrate(80);
        playTone(880, 120);
      } else {
        setResult(classifyResponse(body));
        vibrate([120, 60, 120]);
        playTone(220, 200);
      }
    } catch {
      setResult({ kind: "error", message: "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่" });
      vibrate([120, 60, 120]);
      playTone(220, 200);
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  const submitTokenRef = useRef(submitToken);
  submitTokenRef.current = submitToken;

  // Mount the camera once. Re-running this on every render would restart the
  // video stream constantly; submitToken is instead read through a ref so the
  // effect has no reason to re-fire when it changes identity.
  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (typeof window === "undefined") return;

      if (!window.isSecureContext) {
        setCameraState("unsupported");
        setCameraErrorMessage("ต้องเปิดผ่าน HTTPS จึงจะใช้กล้องได้ กรุณากรอกรหัสด้วยตนเองด้านล่างแทน");
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("unsupported");
        setCameraErrorMessage("อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับกล้อง กรุณากรอกรหัสด้วยตนเองด้านล่างแทน");
        return;
      }

      setCameraState("starting");

      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;

        const instance = new Html5Qrcode(SCANNER_ELEMENT_ID);
        scannerInstanceRef.current = instance;

        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: 250 },
          (decodedText: string) => {
            submitTokenRef.current(decodedText);
          },
          () => {
            // Per-frame "no QR found in this frame" callback — fires
            // continuously while nothing decodable is in view. Not an error.
          }
        );

        if (!cancelled) setCameraState("active");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);

        if (/notallowederror|permission denied/i.test(message)) {
          setCameraState("denied");
        } else if (/notfounderror|no camera|no device/i.test(message)) {
          setCameraState("unsupported");
          setCameraErrorMessage("ไม่พบกล้องบนอุปกรณ์นี้ กรุณากรอกรหัสด้วยตนเองด้านล่างแทน");
        } else {
          setCameraState("error");
          setCameraErrorMessage("เปิดกล้องไม่สำเร็จ กรุณาลองใหม่ หรือกรอกรหัสด้วยตนเองด้านล่างแทน");
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      const instance = scannerInstanceRef.current;
      if (instance) {
        instance
          .stop()
          .then(() => instance.clear())
          .catch(() => {
            // Best-effort teardown — nothing useful to do if stop() rejects
            // (e.g. it was never fully started before unmount).
          });
      }
    };
  }, []);

  function handleManualSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitToken(manualToken);
    setManualToken("");
  }

  const resultVariant =
    result?.kind === "success" ? "success" : result?.kind === "forbidden" ? "warning" : result ? "error" : null;

  return (
    <div className="checkin-scanner">
      <div className="checkin-scanner__count" role="status" aria-live="polite">
        เช็คอินแล้ว <strong>{sessionCount}</strong> ใบ (รอบนี้)
      </div>

      <div className="card checkin-scanner__camera-card">
        {/* html5-qrcode injects the <video> feed into this element itself —
            it must stay mounted regardless of cameraState so the library has
            somewhere to attach once it initializes. */}
        <div id={SCANNER_ELEMENT_ID} className="checkin-scanner__viewport" />

        {cameraState === "idle" || cameraState === "starting" ? (
          <p className="text-muted checkin-scanner__hint" role="status" aria-live="polite">
            กำลังเปิดกล้อง...
          </p>
        ) : null}

        {cameraState === "active" && !result && (
          <p className="text-muted checkin-scanner__hint">พร้อมสแกน — เล็ง QR โค้ดบนตั๋วให้อยู่ในกรอบ</p>
        )}

        {cameraState === "denied" && (
          <div className="alert alert-warning" role="alert">
            <p>ไม่ได้รับอนุญาตให้ใช้กล้อง</p>
            <p>
              กรุณาเปิดสิทธิ์การใช้กล้องให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ (ไอคอนกุญแจ/กล้องที่แถบที่อยู่) แล้วโหลดหน้านี้ใหม่
              หรือกรอกรหัสด้วยตนเองด้านล่างแทนระหว่างนี้
            </p>
          </div>
        )}

        {cameraState === "unsupported" && (
          <div className="alert alert-warning" role="alert">
            <p>{cameraErrorMessage ?? "ไม่สามารถใช้กล้องสแกนได้บนอุปกรณ์นี้"}</p>
          </div>
        )}

        {cameraState === "error" && (
          <div className="alert alert-error" role="alert">
            <p>{cameraErrorMessage ?? "เปิดกล้องไม่สำเร็จ"}</p>
          </div>
        )}
      </div>

      {result && (
        <div
          className={`checkin-result checkin-result--${resultVariant}`}
          role={result.kind === "success" ? "status" : "alert"}
          aria-live={result.kind === "success" ? "polite" : "assertive"}
        >
          {result.kind === "success" && (
            <>
              <p className="checkin-result__title">เช็คอินสำเร็จ ✓</p>
              <p>{result.data.tierName}</p>
              <p>เลขที่ตั๋ว {result.data.serialNo}</p>
              <p className="text-muted">{result.data.attendeeEmail}</p>
            </>
          )}

          {result.kind === "already" && (
            <>
              <p className="checkin-result__title">เช็คอินไปแล้ว</p>
              {result.checkedInAt && <p>เมื่อ {formatDateTimeBangkok(result.checkedInAt)}</p>}
            </>
          )}

          {result.kind === "void" && (
            <>
              <p className="checkin-result__title">ตั๋วถูกยกเลิก</p>
              <p>ตั๋วใบนี้ถูกยกเลิกแล้ว ไม่สามารถเช็คอินได้</p>
            </>
          )}

          {result.kind === "not_found" && (
            <>
              <p className="checkin-result__title">ไม่พบตั๋วนี้</p>
              <p>ตรวจสอบว่าเป็น QR โค้ดของงานนี้ หรือลองสแกน/กรอกรหัสใหม่อีกครั้ง</p>
            </>
          )}

          {result.kind === "invalid" && (
            <>
              <p className="checkin-result__title">ตั๋วไม่ถูกต้อง</p>
              <p>{translateApiError("INVALID_TOKEN")}</p>
            </>
          )}

          {result.kind === "forbidden" && (
            <>
              <p className="checkin-result__title">ไม่มีสิทธิ์</p>
              <p>{translateApiError("NOT_EVENT_STAFF")}</p>
            </>
          )}

          {result.kind === "error" && (
            <>
              <p className="checkin-result__title">ทำรายการไม่สำเร็จ</p>
              <p>{result.message}</p>
            </>
          )}

          <button type="button" className="btn btn-ghost checkin-result__dismiss" onClick={() => setResult(null)}>
            สแกนต่อ
          </button>
        </div>
      )}

      <div className="card checkin-scanner__manual">
        <h2>กรอกรหัสด้วยตนเอง</h2>
        <p className="text-muted">ใช้กรณีกล้องมีปัญหา หรือ QR โค้ดสแกนไม่ติด</p>
        <form onSubmit={handleManualSubmit} className="form-stack">
          <label htmlFor="manual-token" className="sr-only">
            รหัสตั๋ว (token)
          </label>
          <input
            id="manual-token"
            type="text"
            value={manualToken}
            onChange={(event) => setManualToken(event.target.value)}
            placeholder="วางหรือพิมพ์รหัสตั๋วที่นี่"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="btn btn-primary" disabled={submitting || !manualToken.trim()}>
            {submitting ? "กำลังตรวจสอบ..." : "ยืนยันเช็คอิน"}
          </button>
        </form>
      </div>
    </div>
  );
}
