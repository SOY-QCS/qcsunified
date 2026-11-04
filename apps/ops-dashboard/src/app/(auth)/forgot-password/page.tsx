"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { normalizeGhanaPhone } from "@qcs/types";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Brand, friendly } from "../brand";

/**
 * Forgot password:
 *  • Email: we send a reset link (Supabase → Resend email).
 *  • Phone: we text a code (Hubtel); after the code, the staff member sets a new password.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [id, setId] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sb = supabaseBrowser();

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const { error } = await sb.auth.resetPasswordForEmail(id.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setBusy(false);
    // Same message whether or not the email exists, so nobody can probe staff emails.
    if (error && !error.message.toLowerCase().includes("not found")) return setError(friendly(error.message));
    setDone("If that email belongs to a QCS staff account, a reset link is on its way. Check your inbox.");
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const phone = normalizeGhanaPhone(id);
    if (!phone) return setError("Enter a Ghana phone number, e.g. 024 123 4567");
    setBusy(true);
    const { error } = await sb.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) return setError(friendly(error.message));
    setCodeSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const phone = normalizeGhanaPhone(id)!;
    const { error } = await sb.auth.verifyOtp({ phone, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) return setError(friendly(error.message));
    router.replace("/reset-password");
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <Brand subtitle="Reset your password" />
        {done ? <p className="notice">{done}</p> : (
          <>
            <div className="tabs" role="group" aria-label="Reset with">
              <button type="button" aria-pressed={mode === "email"} onClick={() => { setMode("email"); setCodeSent(false); }}>Email link</button>
              <button type="button" aria-pressed={mode === "phone"} onClick={() => setMode("phone")}>SMS code</button>
            </div>
            {mode === "email" ? (
              <form onSubmit={sendEmail}>
                <label htmlFor="email">Your staff email</label>
                <input id="email" type="email" required value={id} onChange={(e) => setId(e.target.value)} />
                <button className="btn block" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
              </form>
            ) : !codeSent ? (
              <form onSubmit={sendCode}>
                <label htmlFor="phone">Your phone number</label>
                <input id="phone" type="tel" required placeholder="024 123 4567" value={id} onChange={(e) => setId(e.target.value)} />
                <button className="btn block" disabled={busy}>{busy ? "Sending…" : "Text me a code"}</button>
              </form>
            ) : (
              <form onSubmit={verifyCode}>
                <p className="muted">We sent a 6-digit code to {id}.</p>
                <label htmlFor="code">Code</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
                <button className="btn block" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
              </form>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        <p className="muted" style={{ textAlign: "center", marginTop: 14 }}><Link href="/login">Back to sign in</Link></p>
      </div>
    </main>
  );
}
