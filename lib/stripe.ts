import "server-only";
import Stripe from "stripe";

/**
 * Lazily-initialised Stripe client.
 *
 * The client is created on first *use*, not at module load. `next build`
 * imports every route module to collect page data, and a route that imports
 * this file must not throw just because STRIPE_SECRET_KEY isn't present in the
 * build environment (it's a runtime secret). Initialising eagerly at module
 * scope broke `next build` with "Missing STRIPE_SECRET_KEY environment
 * variable" during page-data collection.
 *
 * Exposed as a Proxy so existing call sites keep using `stripe.paymentIntents`,
 * `stripe.webhooks`, `stripe.refunds`, etc. unchanged — the real client is
 * built on the first property access (i.e. at request time, where the secret
 * is available), and reused thereafter.
 */
let client: Stripe | null = null;

function getClient(): Stripe {
  if (client) return client;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY environment variable");
  }
  client = new Stripe(secretKey, {
    apiVersion: "2024-06-20",
    typescript: true,
  });
  return client;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getClient(), prop, receiver);
    return typeof value === "function" ? value.bind(getClient()) : value;
  },
});
