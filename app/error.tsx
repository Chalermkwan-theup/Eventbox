"use client";

import { useEffect } from "react";

/**
 * Root error boundary — catches anything an SC page throws (e.g. an
 * unhandled Supabase error) that wasn't already turned into an inline
 * "alert-error" state by the page itself. Must be a Client Component (Next.js
 * requirement for error.tsx).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="container container--narrow empty-state">
      <h1>เกิดข้อผิดพลาดที่ไม่คาดคิด</h1>
      <p>กรุณาลองใหม่อีกครั้ง หากยังพบปัญหาต่อเนื่องกรุณาติดต่อทีมงาน</p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        ลองใหม่อีกครั้ง
      </button>
    </div>
  );
}
