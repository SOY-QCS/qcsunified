"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Brand, friendly } from "../../brand";

/** Second step for staff who switched on 2FA: the 6-digit code from their authenticator app. */
export default function MfaPage() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabaseBrowser().auth.mfa.listFactors().then(({ data }) => {
      const f = data?.totp?.find((x) => x.status === "verified");
      if (f) setFactorId(f.id); else router.replace(next);
    });
  }, [router, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true); setError(null);
    const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setError(friendly(error.message));
    router.replace(next);
    router.refresh();
  }

  async function cancel() {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <Brand subtitle="Two-step verification" />
        <p className="muted">Open your authenticator app and enter the 6-digit code for QCS Operations.</p>
        <label htmlFor="code">Code</label>
        <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy || !factorId}>{busy ? "Checking…" : "Verify"}</button>
        <button type="button" className="btn secondary block" onClick={cancel}>Use a different account</button>
      </form>
    </main>
  );
}
