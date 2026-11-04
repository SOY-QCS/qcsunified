import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { ApproveBatch } from "./approve";

/** One batch: every payee, amount, MoMo number and hold reason, with Approve & send / Cancel / release holds. */
export default async function Batch({ params }: PageProps<"/finance/payouts/[id]">) {
  const me = await requireRole(["super_admin", "finance", "analyst"]);
  const canAct = has(me, "super_admin", "finance");
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: b } = await sb.from("payout_batches").select("*").eq("id", id).maybeSingle();
  if (!b) notFound();
  const { data: ps } = await sb.from("payouts").select("id, payee_type, payee_id, amount, fee, momo_number, momo_network, status, hold_reason, failure_reason, paid_at, client_reference").eq("batch_id", id).order("amount", { ascending: false });
  const ids = (ps ?? []).map((p) => p.payee_id);
  const [{ data: people }, { data: vendors }] = await Promise.all([
    sb.from("profiles").select("id, full_name, phone").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    sb.from("vendors").select("id, business_name").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const name = (p: { payee_type: string | null; payee_id: string | null }) =>
    p.payee_type === "vendor" ? vendors?.find((v) => v.id === p.payee_id)?.business_name : people?.find((x) => x.id === p.payee_id)?.full_name;
  const total = (ps ?? []).reduce((s, p) => s + p.amount, 0);
  const toSend = (ps ?? []).filter((p) => p.status === "requested");
  const selfMade = b.created_by === me.id;
  return (
    <>
      <p><Link href="/finance/payouts">← Payout batches</Link></p>
      <h1>{b.kind === "rider" ? "Rider earnings" : "Vendor COD"} batch <span className="tag">{b.status}</span></h1>
      <p className="muted">Prepared {when(b.created_at)} · {b.note} · total {ghs(total)}</p>
      {canAct && b.status === "draft" && (
        <div className="card">
          <strong>Approve: {toSend.length} payout(s), {ghs(toSend.reduce((s, p) => s + p.amount, 0))}</strong>
          <p className="muted">Check the names, amounts and MoMo numbers. Held payouts are not sent — release them first if they should be.</p>
          {selfMade ? <p className="error">You prepared this batch, so someone else in Finance must approve it.</p> : <ApproveBatch id={id} />}
          <div style={{ marginTop: 12 }}><RpcButton fn="cancel_payout_batch" args={{ p_batch: id }} reason="p_reason" done="Cancelled. Everything is back in the wallets." label="Cancel batch" kind="danger" /></div>
        </div>
      )}
      <table>
        <thead><tr><th>Payee</th><th>MoMo</th><th>Amount</th><th>Status</th>{canAct && <th></th>}</tr></thead>
        <tbody>
          {(ps ?? []).map((p) => (
            <tr key={p.id} className={p.status === "held" || p.status === "failed" ? "bad" : undefined}>
              <td>{p.payee_type === "rider" ? <Link href={`/riders/${p.payee_id}`}>{name(p)}</Link> : p.payee_type === "vendor" ? <Link href={`/vendors/${p.payee_id}`}>{name(p)}</Link> : name(p)}</td>
              <td>{p.momo_number}<br /><span className="muted">{p.momo_network}</span></td>
              <td>{ghs(p.amount)}</td>
              <td>{p.status}{p.paid_at && ` ${when(p.paid_at)}`}{(p.hold_reason || p.failure_reason) && <><br /><span className="muted">{p.hold_reason ?? p.failure_reason}</span></>}</td>
              {canAct && <td>{p.status === "held" && <RpcButton fn="release_payout_hold" args={{ p_payout: p.id }} reason="p_reason" done="Released — approve the batch to send it." label="Release hold" kind="secondary" />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
