import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-redirect";

export const dynamic = "force-dynamic";

/**
 * GET /auth/confirm
 * Landing target for the magic link Supabase emails from
 * supabase.auth.signInWithOtp() (see app/login/page.tsx). Exchanges the
 * token_hash + type pair for a session cookie via verifyOtp, then redirects
 * to a sanitised same-origin `next` (defaults to /events; see safeNext in
 * lib/safe-redirect.ts). Standard @supabase/ssr App Router pattern —
 * see https://supabase.com/docs/guides/auth/server-side/nextjs.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(searchParams.get("next"), origin);

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      return NextResponse.redirect(next);
    }
  }

  return NextResponse.redirect(new URL("/login?error=confirm_failed", origin));
}
