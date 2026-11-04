"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface Factor { id: string; status: string; friendly_name?: string }

/** Two-step verification with an authenticator app (optional for staff). */
export default function SecurityPage() {
  const sb = supabaseBrowser();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data } = await sb.auth.mfa.listFactors();
    setFactors((data?.totp ?? []) as Factor[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  async function start() {
    setMsg(null);
    // remove half-finished attempts first
    for (const f of factors.filter((f) => f.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `QCS ${new Date().toISOString().slice(0, 10)}` });
    if (error) return setMsg({ ok: false, text: error.message });
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.trim() });
    if (error) return setMsg({ ok: false, text: "That code didn't work. Check the time on your phone is correct and try again." });
    setEnrolling(null); setCode("");
    setMsg({ ok: true, text: "Two-step verification is on. You'll be asked for a code each time you sign in." });
    load();
  }

  async function remove(id: string) {
    const { error } = await sb.auth.mfa.unenroll({ factorId: id });
    if (error) return setMsg({ ok: false, text: error.message });
    setMsg({ ok: true, text: "Two-step verification switched off." });
    load();
  }

  const verified = factors.filter((f) => f.status === "verified");
  return (
    <>
      <h1>My account &amp; 2FA</h1>
      <div className="card">
        <strong>Password</strong>
        <p className="muted">Change the password you use to sign in.</p>
        <Link className="btn secondary small" href="/reset-password">Change password</Link>
      </div>
      <div className="card">
        <strong>Two-step verification</strong>
        <p className="muted">After your password, you&apos;ll also enter a 6-digit code from an app such as Google Authenticator or Microsoft Authenticator.</p>
        {verified.length > 0 ? (
          verified.map((f) => (
            <p key={f.id}>✅ On ({f.friendly_name}) <button className="btn danger small" onClick={() => remove(f.id)}>Switch off</button></p>
          ))
        ) : enrolling ? (
          <form onSubmit={confirm}>
            <p>1. Scan this with your authenticator app:</p>
            <img src={enrolling.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: "#fff" }} />
            <p className="muted">Can&apos;t scan? Enter this key: <code>{enrolling.secret}</code></p>
            <label htmlFor="code">2. Enter the 6-digit code it shows</label>
            <input id="code" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 200 }} />
            <div><button className="btn" style={{ marginTop: 12 }}>Turn on</button></div>
          </form>
        ) : (
          <button className="btn" onClick={start}>Set up two-step verification</button>
        )}
        {msg && <p className={msg.ok ? "notice" : "error"}>{msg.text}</p>}
      </div>
    </>
  );
}
