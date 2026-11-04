"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Brand, friendly } from "../brand";

/** Set a new password — reached from the reset email, the SMS code, or a first-time staff invite. */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabaseBrowser().auth.getUser().then(({ data }) => setReady(!!data.user));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    if (pw !== pw2) return setError("The two passwords don't match.");
    if (pw.length < 10 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
      return setError("Use at least 10 characters with upper and lower case letters and a number.");
    }
    setBusy(true);
    const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setError(friendly(error.message));
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <Brand subtitle="Choose a new password" />
        {ready === false ? (
          <p className="error">This link has expired. Ask for a new one from the <a href="/forgot-password">forgot password</a> page.</p>
        ) : (
          <>
            <label htmlFor="pw">New password</label>
            <input id="pw" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
            <label htmlFor="pw2">Type it again</label>
            <input id="pw2" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <p className="muted">At least 10 characters, with upper and lower case letters and a number.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="btn block" disabled={busy || !ready}>{busy ? "Saving…" : "Save password"}</button>
          </>
        )}
      </form>
    </main>
  );
}
