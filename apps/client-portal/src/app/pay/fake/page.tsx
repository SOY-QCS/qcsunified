"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

/** Local testing only (DEV_FAKE_PAYMENTS=1): stands in for Hubtel's payment page. */
function Fake() {
  const sp = useSearchParams();
  const ref = sp.get("ref") ?? "";
  const go = async (ok: boolean) => {
    await fetch("/api/v1/payments/fake-complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref, ok }) });
    window.location.href = `/pay/return?ref=${ref}${sp.get("app") ? "&app=1" : ""}`;
  };
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>Test payment</h1>
        <p className="muted">Hubtel isn&apos;t connected yet, so this page pretends to be Hubtel. No real money moves.</p>
        <button className="btn block" onClick={() => go(true)}>Pay (succeeds)</button>
        <button className="btn secondary block" onClick={() => go(false)}>Decline (fails)</button>
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><Fake /></Suspense>; }
