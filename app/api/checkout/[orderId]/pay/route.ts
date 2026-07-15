import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";
import { uuidSchema } from "@/lib/validation";
import { mapRpcError } from "@/lib/errors";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import type Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/:orderId/pay
 * Creates a Stripe PromptPay PaymentIntent for a pending order and returns the
 * client_secret so the frontend can render the PromptPay QR. Payment
 * confirmation itself is fully asynchronous — see /api/webhooks/stripe.
 */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  const idCheck = uuidSchema.safeParse(orderId);
  if (!idCheck.success) {
    return NextResponse.json({ error: "INVALID_ORDER_ID", message: "Malformed order id." }, { status: 400 });
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED", message: "Sign in required." }, { status: 401 });
  }

  // Caps repeated PaymentIntent creation attempts against the same account
  // (e.g. a broken client retry-looping this endpoint).
  const payLimited = await enforceRateLimit(
    supabase,
    `pay:${user.id}`,
    RATE_LIMITS.PAY.max,
    RATE_LIMITS.PAY.windowSeconds
  );
  if (payLimited) return payLimited;

  // RLS scopes this to orders the caller owns (or is org staff for) — an order
  // belonging to someone else simply won't be returned here.
  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("id, status, total_satang, stripe_payment_intent_id, user_id")
    .eq("id", orderId)
    .maybeSingle();

  if (fetchError) {
    console.error("Failed to load order for payment", fetchError);
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "Could not load order." }, { status: 500 });
  }

  if (!order || order.user_id !== user.id) {
    return NextResponse.json({ error: "ORDER_NOT_FOUND", message: "Order not found." }, { status: 404 });
  }

  if (order.status !== "pending_payment") {
    return NextResponse.json(
      { error: "ORDER_NOT_PENDING", message: "Order is no longer awaiting payment." },
      { status: 409 }
    );
  }

  if (order.total_satang <= 0) {
    return NextResponse.json(
      { error: "INVALID_ORDER_TOTAL", message: "Order total must be greater than zero to charge." },
      { status: 409 }
    );
  }

  // Statuses where the existing PromptPay PaymentIntent can still be paid —
  // safe to hand the same client_secret back out instead of minting another one.
  const REUSABLE_INTENT_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
    "requires_payment_method",
    "requires_action",
  ]);
  // Statuses Stripe will actually let us cancel — anything else (succeeded,
  // already canceled) needs no cleanup before creating a fresh PaymentIntent.
  const CANCELABLE_INTENT_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
    "requires_payment_method",
    "requires_capture",
    "requires_confirmation",
    "requires_action",
    "processing",
  ]);

  let paymentIntent: Stripe.PaymentIntent | null = null;

  // Security fix: repeated calls to this endpoint used to unconditionally
  // create a brand-new PaymentIntent and overwrite stripe_payment_intent_id,
  // leaving every earlier PI still payable — a customer (or anyone who gets
  // hold of an old client_secret) could pay more than one of them and only
  // the first confirm_order_paid() call would count; the rest now get
  // refunded automatically (see ALREADY_PAID_DIFFERENT_INTENT in
  // app/api/webhooks/stripe/route.ts), but that's a fix for the symptom, not
  // the cause. Reuse the existing PI whenever it's still payable and for the
  // right amount, instead of creating a new one every time.
  if (order.stripe_payment_intent_id) {
    try {
      const existing = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);

      if (REUSABLE_INTENT_STATUSES.has(existing.status) && existing.amount === order.total_satang) {
        paymentIntent = existing;
      } else if (CANCELABLE_INTENT_STATUSES.has(existing.status)) {
        // Stale (wrong amount) or otherwise no longer reusable — cancel it so
        // it can never be paid alongside whatever we create next.
        await stripe.paymentIntents.cancel(existing.id).catch((cancelErr) => {
          console.error(`Failed to cancel stale PaymentIntent ${existing.id} for order ${order.id}`, cancelErr);
        });
      }
      // else: already succeeded/canceled — nothing to clean up, fall through.
    } catch (err) {
      console.error(
        `Failed to retrieve existing PaymentIntent ${order.stripe_payment_intent_id} for order ${order.id}`,
        err
      );
      // Fall through and create a fresh PaymentIntent — better to risk a
      // duplicate (which the webhook's ALREADY_PAID_DIFFERENT_INTENT refund
      // path now handles) than to block checkout because Stripe was
      // momentarily unreachable for the retrieve call.
    }
  }

  if (paymentIntent) {
    // Already attached to this order from a previous call — nothing new to persist.
    return NextResponse.json({
      orderId: order.id,
      clientSecret: paymentIntent.client_secret,
      totalSatang: order.total_satang,
    });
  }

  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: order.total_satang,
      currency: "thb",
      payment_method_types: ["promptpay"],
      metadata: { order_id: order.id },
    });
  } catch (err) {
    console.error("Stripe PaymentIntent creation failed", err);
    return NextResponse.json(
      { error: "PAYMENT_PROVIDER_ERROR", message: "Could not start payment. Please try again." },
      { status: 502 }
    );
  }

  // Persist the intent id via a narrow SECURITY DEFINER RPC scoped to the
  // caller's own pending order (see attach_payment_intent in 0002) rather than
  // reaching for the service-role client on a user-triggered request.
  const { error: attachError } = await supabase.rpc("attach_payment_intent", {
    p_order_id: order.id,
    p_intent_id: paymentIntent.id,
  });

  if (attachError) {
    // Best-effort cleanup: don't leave an orphaned, unusable PaymentIntent behind.
    await stripe.paymentIntents.cancel(paymentIntent.id).catch((cancelErr) => {
      console.error("Failed to cancel orphaned PaymentIntent", cancelErr);
    });
    return mapRpcError(attachError);
  }

  return NextResponse.json({
    orderId: order.id,
    clientSecret: paymentIntent.client_secret,
    totalSatang: order.total_satang,
  });
}
