// CSP for this app's third parties: Stripe.js (js.stripe.com + its hidden
// iframes/images on *.stripe.com) and Supabase (REST over https + Realtime over
// wss). Shipped as Content-Security-Policy-Report-Only first: it reports
// violations without breaking payment/Realtime, so the exact allowlist can be
// verified against a live Stripe test-mode checkout before flipping the header
// name to the enforcing `Content-Security-Policy`.
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com",
  "frame-src https://js.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Enforced now (safe, no third-party interaction): stops the staff
          // check-in/dashboard pages from being framed for clickjacking.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
};

export default nextConfig;
