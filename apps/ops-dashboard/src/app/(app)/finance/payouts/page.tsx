import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { FinanceTabs } from "../tabs";

/** Payout batches: prepared automatically each morning (or by hand here), sent only after a second Finance person approves. */
export default async function Batches() {
  const me = await requireRole(["super_admin", "finance", "analyst"]);
  const canAct = has(me, "super_admin", "finance");
  const sb = await supabaseServer();
  const { data: batches } = await sb.from("payout_batches").select("id, kind, status, note, created_at, approved_at, cancel_reason, created_by, creator:profiles!payout_batches_created_by_fkey(full_name), approver:profiles!payout_batches_approved_by_fkey(full_name), payouts(amount, status)")
    .order("created_at", { ascending: false }).limit(60);
  return (
    <>
      <h1>Finance</h1>
      <FinanceTabs at="/finance/payouts" />
      {canAct && (
        <div className="card">
          <strong>Prepare a batch now</strong>
          <p className="muted">Batches are also prepared automatically at 06:00: vendor COD daily, plus riders and weekly vendors on the payout day (Settings). Preparing sets the money aside; nothing is sent until someone else in Finance approves.</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <RpcButton fn="create_rider_payout_batch" args={{ p_city: null }} done="Rider batch prepared — open it below." label="Rider earnings" />
            <RpcButton fn="create_vendor_cod_batch" args={{ p_schedule: "daily", p_city: null }} done="Prepared." label="Vendor COD (daily vendors)" kind="secondary" />
            <RpcButton fn="create_vendor_cod_batch" args={{ p_schedule: "weekly", p_city: null }} done="Prepared." label="Vendor COD (weekly vendors)" kind="secondary" />
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>Prepared</th><th>Batch</th><th>Payouts</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>
          {(batches ?? []).map((b) => {
            const ps = (b.payouts ?? []) as { amount: number; status: string }[];
            const one = <T,>(x: T | T[] | null) => (Array.isArray(x) ? x[0] : x);
            return (
              <tr key={b.id} className={b.status === "draft" ? "bad" : undefined}>
                <td>{when(b.created_at)}<br /><span className="muted">{one(b.creator)?.full_name ?? "automatic"}</span></td>
                <td><Link href={`/finance/payouts/${b.id}`}><strong>{b.kind === "rider" ? "Rider earnings" : "Vendor COD"}</strong></Link><br /><span className="muted">{b.note}</span></td>
                <td>{ps.length}{ps.some((p) => p.status === "held") ? <><br /><span className="tag">{ps.filter((p) => p.status === "held").length} held</span></> : null}</td>
                <td>{ghs(ps.reduce((s, p) => s + p.amount, 0))}</td>
                <td>{b.status === "draft" ? <strong>waiting for approval</strong> : b.status}{b.approved_at && <><br /><span className="muted">by {one(b.approver)?.full_name} {when(b.approved_at)}</span></>}{b.cancel_reason && <><br /><span className="muted">{b.cancel_reason}</span></>}</td>
              </tr>
            );
          })}
          {!batches?.length && <tr><td colSpan={5} className="muted">No batches yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
