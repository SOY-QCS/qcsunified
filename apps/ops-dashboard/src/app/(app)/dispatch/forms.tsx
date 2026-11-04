"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignTrip, decideOverride, restartDispatch, reviewDelivery, type Result } from "./actions";

function useRun() {
  const [pending, start] = useTransition();
  const [r, setR] = useState<Result | null>(null);
  return { pending, run: (fn: () => Promise<Result>) => start(async () => setR(await fn())), Msg: () => (r ? <p className={r.ok ? "notice" : "error"}>{r.message}</p> : null) };
}

/** Reloads the board every 10 seconds so new escalations appear without clicking. */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => { const t = setInterval(() => router.refresh(), 10_000); return () => clearInterval(t); }, [router]);
  return null;
}

export function TripActions({ trip, riders }: { trip: string; riders: { id: string; label: string }[] }) {
  const a = useRun();
  const [rider, setRider] = useState("");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <select value={rider} onChange={(e) => setRider(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Choose a free rider…</option>
          {riders.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <button className="btn small" disabled={a.pending || !rider} onClick={() => a.run(() => assignTrip(trip, rider))}>Assign</button>
        <button className="btn secondary small" disabled={a.pending} onClick={() => a.run(() => restartDispatch(trip))}>Offer again</button>
      </div>
      <a.Msg />
    </div>
  );
}

export function OverrideActions({ id }: { id: string }) {
  const a = useRun();
  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn small" disabled={a.pending} onClick={() => a.run(() => decideOverride(id, true))}>Approve</button>
        <button className="btn danger small" disabled={a.pending} onClick={() => a.run(() => decideOverride(id, false))}>Refuse</button>
      </div>
      <a.Msg />
    </div>
  );
}

export function ReviewForm({ order }: { order: string }) {
  const a = useRun();
  const [note, setNote] = useState("");
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input placeholder="How you checked, e.g. called recipient" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="btn small" disabled={a.pending || note.trim().length < 5} onClick={() => a.run(() => reviewDelivery(order, note))}>Mark checked</button>
      </div>
      <a.Msg />
    </div>
  );
}
