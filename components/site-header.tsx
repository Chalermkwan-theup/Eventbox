import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/sign-out-button";

/**
 * Server Component — reads the current session via lib/supabase/server.ts
 * (RLS/cookie-scoped, same client every SC page uses) purely to decide which
 * nav links to show. No privileged data touched here.
 */
export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href="/events" className="site-header__brand">
          Event Ticketing
        </Link>
        <nav className="site-header__nav" aria-label="เมนูหลัก">
          <Link href="/events">กิจกรรม</Link>
          {user ? (
            <>
              <Link href="/tickets">ตั๋วของฉัน</Link>
              <SignOutButton />
            </>
          ) : (
            <Link href="/login">เข้าสู่ระบบ</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
