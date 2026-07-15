"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Status = "idle" | "sending" | "sent" | "error";

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/events";
  const confirmFailed = searchParams.get("error") === "confirm_failed";

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");
    setErrorMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }

    setStatus("sent");
  }

  if (status === "sent") {
    return (
      <div className="card" role="status">
        <h1>เช็กอีเมลของคุณ</h1>
        <p>
          เราได้ส่งลิงก์สำหรับเข้าสู่ระบบไปที่ <strong>{email}</strong> แล้ว กดลิงก์ในอีเมลเพื่อเข้าสู่ระบบ
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => setStatus("idle")}>
          ใช้อีเมลอื่น
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>เข้าสู่ระบบ</h1>
      <p className="text-muted">กรอกอีเมลเพื่อรับลิงก์เข้าสู่ระบบ ไม่ต้องใช้รหัสผ่าน</p>

      {confirmFailed && (
        <div className="alert alert-warning" role="alert">
          <p>ลิงก์เข้าสู่ระบบหมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่อีกครั้ง</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="form-stack">
        <label htmlFor="email">อีเมล</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        {status === "error" && (
          <p className="form-error" role="alert">
            ส่งลิงก์ไม่สำเร็จ: {errorMessage ?? "กรุณาลองใหม่อีกครั้ง"}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={status === "sending"}>
          {status === "sending" ? "กำลังส่งลิงก์..." : "ส่งลิงก์เข้าสู่ระบบ"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="container container--narrow">
      <Suspense fallback={<div className="card">กำลังโหลด...</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
