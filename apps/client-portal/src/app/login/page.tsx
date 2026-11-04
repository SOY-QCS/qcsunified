"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeGhanaPhone } from "@qcs/types";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** Vendors sign in with the same phone number + SMS code they use in the QCS app. */
export default function Login() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = normalizeGhanaPhone(raw);

  async function send(e?: React.FormEvent) {
    e?.preventDefault(); setError(null);
    if (!phone) return setError("Enter your Ghana phone number, e.g. 024 123 4567");
    setBusy(true);
    const { error } = await supabaseBrowser().auth.signInWithOtp({ phone });
    setBusy(false);
    if (error) return setError(error.message.toLowerCase().includes("rate") ? "Please wait a moment before asking for another code." : error.message);
    setSent(true);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { error } = await supabaseBrowser().auth.verifyOtp({ phone: phone!, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) return setError("That code is wrong or has expired.");
    router.replace("/"); router.refresh();
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark">Q</span><span>QCS Business Portal<br /><span className="muted" style={{ fontWeight: 400 }}>For online vendors and businesses</span></span></div>
        {!sent ? (
          <form onSubmit={send}>
            <label htmlFor="phone">Phone number</label>
            <input id="phone" type="tel" autoComplete="tel" required placeholder="024 123 4567" value={raw} onChange={(e) => setRaw(e.target.value)} />
            {error && <p className="error">{error}</p>}
            <button className="btn block" disabled={busy}>{busy ? "Sending…" : "Text me a code"}</button>
            <p className="muted" style={{ marginTop: 12 }}>New to QCS? Enter your number — you&apos;ll set up your business account next.</p>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="muted">We sent a 6-digit code to {phone}.</p>
            <label htmlFor="code">Code</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <p className="error">{error}</p>}
            <button className="btn block" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
            <button type="button" className="btn secondary block" onClick={() => send()} disabled={busy}>Send a new code</button>
          </form>
        )}
      </div>
    </main>
  );
}
