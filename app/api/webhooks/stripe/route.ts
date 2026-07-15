import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC_ORDER_NOT_PENDING = "ORDER_NOT_PENDING";
const RPC_ORDER_NOT_FOUND = "ORDER_NOT_FOUND";
const RPC_AMOUNT_MISMATCH = "AMOUNT_MISMATCH";
const RPC_ALREADY_PAID_DIFFERENT_INTENT = "ALREADY_PAID_DIFFERENT_INTENT";

/**
 * Refunds a PaymentIntent that must not be honored (hold expired, or the
 * amount actually received doesn't match the order total — see
 * confirm_order_paid's AMOUNT_MISMATCH check in
 * supabase/migrations/0009_confirm_amount_check.sql).
 *
 * Security M3: idempotencyKey is scoped to the payment_intent id (not the
 * event id), so a Stripe redelivery of the same event — or this handler
 * simply being invoked twice for the same intent — can never issue a second,
 * duplicate refund.
 */
async function refundPayment(paymentIntent: Stripe.PaymentIntent, reason: string): Promise<boolean> {
  try {
    await stripe.refunds.create(
      {
        payment_intent: paymentIntent.id,
        reason: "requested_by_customer",
      },
      { idempotencyKey: `refund_${paymentIntent.id}` }
    );
    console.warn(`Refunded payment_intent ${paymentIntent.id}: ${reason}`);
    return true;
  } catch (refundErr) {
    console.error(`Auto-refund failed (${reason})`, refundErr);
    return false;
  }
}

/**
 * POST /api/webhooks/stripe
 * Handles asynchronous PromptPay confirmation. Must:
 *   - verify the Stripe signature before touching anything
 *   - be idempotent (Stripe retries on any non-2xx / timeout)
 *   - auto-refund a payment that lands after the reservation hold expired
 *
 * Idempotency note: confirm_order_paid() is itself idempotent (no-ops when the
 * order is already 'paid' with the same intent id), so a duplicate delivery of
 * the same Stripe event naturally has no side effect — no separate
 * processed-events table is needed for this event type.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "SERVER_MISCONFIGURED" }, { status: 500 });
  }

  if (!signature) {
    return NextResponse.json({ error: "MISSING_SIGNATURE" }, { status: 400 });
  }

  // Raw body is required for signature verification — do not call request.json() first.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
  }

  if (event.type !== "payment_intent.succeeded") {
    // Ack anything we don't care about so Stripe stops retrying it.
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const orderId = paymentIntent.metadata?.order_id;

  if (!orderId) {
    console.error("payment_intent.succeeded missing order_id metadata", paymentIntent.id);
    // Not something a retry will fix — ack so Stripe doesn't keep resending it.
    return NextResponse.json({ received: true, error: "MISSING_ORDER_METADATA" });
  }

  const admin = createAdminClient();

  // Security M2: pass the amount Stripe actually received (not the
  // requested/authorized amount) so confirm_order_paid() can reject a
  // mismatch before issuing any tickets. See 0009_confirm_amount_check.sql.
  const { error } = await admin.rpc("confirm_order_paid", {
    p_order_id: orderId,
    p_stripe_payment_intent_id: paymentIntent.id,
    p_paid_amount: paymentIntent.amount_received,
  });

  if (!error) {
    return NextResponse.json({ received: true });
  }

  const code = error.message?.trim();

  if (code === RPC_ORDER_NOT_PENDING) {
    // Payment landed after the hold expired (or order was cancelled) — refund it.
    // Ack regardless of refund success: retrying confirm_order_paid would just
    // fail the same way, and a failed refund now needs a human to reconcile.
    await refundPayment(paymentIntent, `order ${orderId} was not pending`);
    return NextResponse.json({ received: true, refunded: true });
  }

  if (code === RPC_AMOUNT_MISMATCH) {
    console.error(
      `confirm_order_paid: AMOUNT_MISMATCH for order ${orderId}, intent ${paymentIntent.id} ` +
        `(amount_received=${paymentIntent.amount_received}) — refunding, needs manual review`
    );
    await refundPayment(
      paymentIntent,
      `order ${orderId} amount mismatch (received ${paymentIntent.amount_received})`
    );
    return NextResponse.json({ received: true, refunded: true, error: code });
  }

  if (code === RPC_ALREADY_PAID_DIFFERENT_INTENT) {
    // A second, different PaymentIntent succeeded for an order already paid by
    // another one (e.g. the customer paid twice, or /pay issued a second PI
    // for the same order — see the PI-reuse fix in
    // app/api/checkout/[orderId]/pay/route.ts). This money must go back:
    // without this branch it fell through to the generic 500 below, which
    // makes Stripe retry the same event for days and never refunds the
    // duplicate charge.
    console.error(`order ${orderId} already paid with a different intent; refunding ${paymentIntent.id}`);
    await refundPayment(paymentIntent, `order ${orderId} already paid with a different intent`);
    return NextResponse.json({ received: true, refunded: true, error: code });
  }

  if (code === RPC_ORDER_NOT_FOUND) {
    console.error(`confirm_order_paid: order ${orderId} not found for intent ${paymentIntent.id}`);
    return NextResponse.json({ received: true, error: code });
  }

  console.error("confirm_order_paid failed unexpectedly", error);
  // Unknown failure (e.g. transient DB error) — return 500 so Stripe retries.
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}
