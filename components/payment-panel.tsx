"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Countdown } from "@/components/countdown";
import { useOrderStatus } from "@/lib/hooks/use-order-status";
import { formatSatangToThb } from "@/lib/money";
import { translateApiError } from "@/lib/api-error-messages";

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
// Loaded once at module scope (not per-render) — the standard @stripe/stripe-js
// pattern. `null` when the env var is missing so the component can degrade to
// a clear error instead of throwing during loadStripe(undefined).
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;

/**
 * TODO(frontend-dev, verify before production): the exact shape of
 * PaymentIntent.next_action.promptpay_display_qr_code is NOT confirmed
 * against a live Stripe test-mode response yet. docs-researcher's first pass
 * assumed a shape nested under a `qr_code` key (modeled on Swish's
 * next_action), which the architect flagged as wrong for PromptPay — the
 * real fields are supposed to be FLAT directly on `promptpay_display_qr_code`:
 * `data` (raw QR payload string), `image_url_png`, `image_url_svg`. Confirm
 * field names (and whether e.g. `hosted_instructions_url` also exists) by
 * triggering a real PromptPay PaymentIntent in Stripe test mode and logging
 * `paymentIntent.next_action` before this ships.
 */
interface PromptPayDisplayQrCode {
  data?: string;
  image_url_png?: string;
  image_url_svg?: string;
}

interface PaymentPanelProps {
  orderId: string;
  eventId: string;
  totalSatang: number;
  expiresAt: string;
  userEmail: string | null;
}

type Phase = "loading_intent" | "confirming" | "awaiting_payment" | "local_expired" | "error";

/**
 * PromptPay async payment flow (architect spec, followed exactly):
 *   1. POST /api/checkout/:orderId/pay -> { clientSecret }
 *   2. stripe.confirmPromptPayPayment(clientSecret, ..., { handleActions: false })
 *   3. Render the QR ourselves from next_action.promptpay_display_qr_code
 *   4. Source of truth for "paid" is the webhook -> reflected here via
 *      useOrderStatus (Realtime + poll). We never treat the client-side
 *      confirm call itself as success.
 *   5. Countdown drives an optimistic local "expired" UI; the authoritative
 *      transition (webhook / pg_cron internal_release_order) is picked up by
 *      useOrderStatus and redirects to /orders/:id regardless.
 */
export function PaymentPanel({ orderId, eventId, totalSatang, expiresAt, userEmail }: PaymentPanelProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading_intent");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [qr, setQr] = useState<PromptPayDisplayQrCode | null>(null);
  const startedRef = useRef(false);

  const { data: orderStatus } = useOrderStatus(orderId, {
    status: "pending_payment",
    totalSatang,
    expiresAt,
  });

  // Backend (webhook/cron) is the only source of truth for a resolved order —
  // once it flips away from pending_payment, hand off to /orders/:id, which
  // owns every terminal view (paid / expired / cancelled / refunded).
  useEffect(() => {
    if (orderStatus && orderStatus.status !== "pending_payment") {
      router.replace(`/orders/${orderId}`);
    }
  }, [orderStatus, orderId, router]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function start() {
      if (!publishableKey || !stripePromise) {
        setPhase("error");
        setErrorMessage("ระบบชำระเงินยังไม่พร้อมใช้งาน (ไม่พบการตั้งค่า Stripe) กรุณาติดต่อทีมงาน");
        return;
      }

      try {
        const res = await fetch(`/api/checkout/${orderId}/pay`, { method: "POST" });
        const body = await res.json();

        if (!res.ok) {
          setPhase("error");
          setErrorMessage(translateApiError(body.error));
          return;
        }

        setPhase("confirming");

        const stripe = await stripePromise;
        if (!stripe) {
          setPhase("error");
          setErrorMessage("โหลดระบบชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
          return;
        }

        const result = await stripe.confirmPromptPayPayment(
          body.clientSecret,
          { payment_method: { billing_details: { email: userEmail ?? undefined } } },
          { handleActions: false }
        );

        if (result.error) {
          setPhase("error");
          setErrorMessage(result.error.message ?? "ไม่สามารถสร้าง QR สำหรับชำระเงินได้");
          return;
        }

        // See the TODO above the PromptPayDisplayQrCode type — shape unverified.
        const nextAction = (result.paymentIntent as unknown as {
          next_action?: { promptpay_display_qr_code?: PromptPayDisplayQrCode };
        })?.next_action;
        const qrCode = nextAction?.promptpay_display_qr_code;

        if (!qrCode) {
          setPhase("error");
          setErrorMessage("ไม่พบ QR สำหรับชำระเงิน กรุณาลองใหม่อีกครั้ง");
          return;
        }

        setQr(qrCode);
        setPhase("awaiting_payment");
      } catch {
        setPhase("error");
        setErrorMessage("เกิดข้อผิดพลาดระหว่างเริ่มการชำระเงิน กรุณาลองใหม่อีกครั้ง");
      }
    }

    start();
  }, [orderId, userEmail]);

  function handleLocalExpire() {
    setPhase((current) => (current === "awaiting_payment" ? "local_expired" : current));
  }

  return (
    <div className="payment-panel card">
      <p className="payment-panel__total">
        ยอดชำระ <strong>{formatSatangToThb(totalSatang)}</strong>
      </p>

      {phase !== "local_expired" && <Countdown expiresAt={expiresAt} onExpire={handleLocalExpire} />}

      {(phase === "loading_intent" || phase === "confirming") && (
        <div className="payment-panel__loading" role="status" aria-live="polite">
          <div className="skeleton skeleton-qr" />
          <p>กำลังสร้าง QR สำหรับชำระเงินผ่าน PromptPay...</p>
        </div>
      )}

      {phase === "error" && (
        <div className="alert alert-error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            ลองใหม่อีกครั้ง
          </button>
        </div>
      )}

      {phase === "awaiting_payment" && qr && (
        <div className="payment-panel__qr">
          {qr.image_url_svg || qr.image_url_png ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote/data-URL QR image from Stripe, not a static asset next/image can optimize
            <img
              src={qr.image_url_svg ?? qr.image_url_png}
              alt="QR โค้ด PromptPay สำหรับชำระเงิน"
              width={280}
              height={280}
            />
          ) : (
            <p>ไม่พบรูป QR แต่ยังชำระผ่านแอปธนาคารที่รองรับ PromptPay ได้ตามปกติ</p>
          )}
          <p className="text-muted">สแกน QR นี้ด้วยแอปธนาคารที่รองรับ PromptPay เพื่อชำระเงิน</p>
          <p className="payment-panel__status" role="status" aria-live="polite">
            กำลังตรวจสอบการชำระเงิน... หน้านี้จะพาไปหน้าถัดไปให้อัตโนมัติเมื่อชำระเงินสำเร็จ
          </p>
        </div>
      )}

      {phase === "local_expired" && (
        <div className="alert alert-warning" role="alert">
          <p>หมดเวลาชำระเงินสำหรับคำสั่งซื้อนี้แล้ว</p>
          <a className="btn btn-primary" href={`/events/${eventId}`}>
            เลือกตั๋วและซื้อใหม่
          </a>
        </div>
      )}
    </div>
  );
}
