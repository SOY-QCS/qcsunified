"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rpcAction, type Result } from "@/lib/rpc-action";

/** Runs a server action, shows its message, refreshes the page on success. */
export function useRun() {
  const [pending, start] = useTransition();
  const [r, setR] = useState<Result | null>(null);
  const router = useRouter();
  return {
    pending, result: r,
    run: (fn: () => Promise<Result>, then?: (r: Result) => void) => start(async () => { const x = await fn(); setR(x); if (x.ok) { router.refresh(); then?.(x); } }),
    Msg: () => (r ? <p className={r.ok ? "notice" : "error"}>{r.message}</p> : null),
  };
}

/** A button that calls one database function (optionally asking for a reason first). */
export function RpcButton({ fn, args, done, label, kind = "", reason, confirm }: {
  fn: string; args: Record<string, unknown>; done: string; label: string; kind?: "" | "secondary" | "danger";
  /** name of the argument that takes a typed reason, e.g. "p_reason" */ reason?: string; confirm?: string;
}) {
  const a = useRun();
  const [why, setWhy] = useState("");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {reason && <input placeholder="Reason" value={why} onChange={(e) => setWhy(e.target.value)} style={{ maxWidth: 260 }} />}
        <button className={`btn small ${kind}`} disabled={a.pending || (!!reason && why.trim().length < 5)}
          onClick={() => { if (confirm && !window.confirm(confirm)) return; a.run(() => rpcAction(fn, reason ? { ...args, [reason]: why } : args, done)); }}>{label}</button>
      </div>
      <a.Msg />
    </div>
  );
}

/** City filter that keeps the other filters in the address bar. */
export function CityPicker({ cities, value, allowAll }: { cities: { id: string; name: string }[]; value: string | null; allowAll: boolean }) {
  const router = useRouter();
  if (cities.length <= 1 && !allowAll) return null;
  return (
    <select value={value ?? ""} style={{ maxWidth: 220 }} onChange={(e) => {
      const u = new URL(window.location.href);
      if (e.target.value) u.searchParams.set("city", e.target.value); else u.searchParams.delete("city");
      router.push(u.pathname + u.search);
    }}>
      {allowAll && <option value="">All cities</option>}
      {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
