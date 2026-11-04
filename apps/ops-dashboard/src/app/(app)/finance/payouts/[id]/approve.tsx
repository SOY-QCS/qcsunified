"use client";
import { useRun } from "@/components/run";
import { approveBatch } from "../../actions";

export function ApproveBatch({ id }: { id: string }) {
  const a = useRun();
  return (
    <div>
      <button className="btn" disabled={a.pending} onClick={() => { if (window.confirm("Send this money now through Hubtel?")) a.run(() => approveBatch(id)); }}>
        {a.pending ? "Sending…" : "Approve & send"}</button>
      <a.Msg />
    </div>
  );
}
