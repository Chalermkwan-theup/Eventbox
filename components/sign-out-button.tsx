"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSignOut() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    setLoading(false);
    router.push("/login");
    router.refresh();
  }

  return (
    <button type="button" className="btn btn-ghost" onClick={handleSignOut} disabled={loading}>
      {loading ? "กำลังออกจากระบบ..." : "ออกจากระบบ"}
    </button>
  );
}
