"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { normalizeGhanaPhone } from "@qcs/types";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Brand, friendly } from "../brand";

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const sb = supabaseBrowser();
    let res;
    if (mode === "phone") {
      const phone = normalizeGhanaPhone(id);
      if (!phone) { setBusy(false); return setError("Enter a Ghana phone number, e.g. 024 123 4567"); }
      res = await sb.auth.signInWithPassword({ phone, password });
    } else {
      res = await sb.auth.signInWithPassword({ email: id.trim(), password });
    }
    if (res.error) { setBusy(false); return setError(friendly(res.error.message)); }

    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      router.replace(`/login/mfa?next=${encodeURIComponent(next)}`);
    } else {
      router.replace(next);
      router.refresh();
    }
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <Brand subtitle="Staff sign in" />
        <div className="tabs" role="group" aria-label="Sign in with">
          <button type="button" aria-pressed={mode === "email"} onClick={() => setMode("email")}>Email</button>
          <button type="button" aria-pressed={mode === "phone"} onClick={() => setMode("phone")}>Phone</button>
        </div>
        <label htmlFor="id">{mode === "email" ? "Email" : "Phone number"}</label>
        <input id="id" required autoComplete={mode === "email" ? "email" : "tel"} type={mode === "email" ? "email" : "tel"}
          placeholder={mode === "email" ? "you@qcsghana.com" : "024 123 4567"} value={id} onChange={(e) => setId(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted" style={{ textAlign: "center", marginTop: 14 }}>
          <Link href="/forgot-password">Forgot password?</Link>
        </p>
      </form>
    </main>
  );
}
