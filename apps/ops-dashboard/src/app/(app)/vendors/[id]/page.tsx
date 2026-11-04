import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ghs, has, statusText, when } from "@/lib/ops";
import { RpcButton } from "@/components/run";
import { VendorControls } from "./controls";

export default async function VendorPage({ params }: PageProps<"/vendors/[id]">) {
  const me = await requireRole(["super_admin", "city_admin", "support", "analyst", "finance"]);
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: v } = await sb.from("vendors").select("*, cities(name)").eq("id", id).maybeSingle();
  if (!v) notFound();
  const [{ data: stats }, { data: orders }, { data: staff }, { data: managers }] = await Promise.all([
    sb.rpc("vendor_stats", { p_vendor: id }),
    sb.from("orders").select("tracking_number, status, created_at, recipient_name, quoted_fee, cod_amount").eq("vendor_id", id).order("created_at", { ascending: false }).limit(15),
    sb.from("vendor_staff").select("user_id, permissions, is_active, profiles(full_name, phone)").eq("vendor_id", id),
    sb.from("user_roles").select("user_id, profiles!user_roles_user_id_fkey(full_name)").in("role", ["super_admin", "city_admin", "support"]),
  ]);
  const idDoc = v.id_doc_path ? (await sb.storage.from("kyc").createSignedUrl(v.id_doc_path, 600)).data?.signedUrl : null;
  const s = (stats ?? {}) as Record<string, number | boolean | null>;
  const mgrs = [...new Map((managers ?? []).map((m) => [m.user_id, (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.full_name ?? "Staff"])).entries()].map(([id2, name]) => ({ id: id2, name }));
  return (
    <>
      <p><Link href="/vendors">← Vendors</Link></p>
      <h1>{v.business_name} <span className="tag">{v.account_type}</span>{s.churn_risk ? <span className="tag">churn risk</span> : null}</h1>
      <p>{v.contact_phone} · {v.contact_email} · {(Array.isArray(v.cities) ? v.cities[0] : v.cities)?.name} · since {when(v.created_at)}</p>
      <div className="row">
        {[["Orders this week", s.orders_7d], ["Weekly average (4 wks)", s.weekly_avg_4w], ["Delivered (30 days)", s.delivered_30d], ["Failed/returned (30 days)", s.failed_30d],
          ["Wallet", ghs(s.wallet_balance as number)], ["COD not yet paid out", ghs(s.cod_collected_not_paid as number)], ["Pickup rating (riders)", s.pickup_rating ? `★ ${s.pickup_rating}` : "—"]].map(([k, val]) => (
          <div key={String(k)} className="card" style={{ padding: 12 }}><div className="muted">{k}</div><div style={{ fontSize: 20, fontWeight: 800 }}>{String(val ?? "—")}</div></div>
        ))}
      </div>

      <div className="card">
        <strong>ID check: {v.kyc_status}</strong> {idDoc && <> · <a href={idDoc} target="_blank" rel="noreferrer">view {v.id_type?.replaceAll("_", " ")} ({v.id_number})</a></>}
        {v.kyc_status === "pending" && (has(me, "super_admin", "city_admin", "support")) && <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <RpcButton fn="review_vendor_kyc" args={{ p_vendor_id: id, p_approve: true }} done="Verified" label="Approve ID" />
          <RpcButton fn="review_vendor_kyc" args={{ p_vendor_id: id, p_approve: false }} reason="p_note" done="Refused" label="Refuse" kind="danger" />
        </div>}
      </div>

      <VendorControls id={id} v={{ booking_blocked: v.booking_blocked, cod_payout_on_hold: v.cod_payout_on_hold, cod_payout_schedule: v.cod_payout_schedule,
        pod_require_photo: v.pod_require_photo, pod_require_pickup_code: v.pod_require_pickup_code, cs_service_enabled: v.cs_service_enabled,
        fulfilment_enabled: v.fulfilment_enabled, account_manager_id: v.account_manager_id ?? "" }}
        reason={v.booking_block_reason} managers={mgrs} canMoney={has(me, "super_admin", "finance")} canOther={has(me, "super_admin", "city_admin", "finance")} />

      <h2>Team</h2>
      <table><tbody>{(staff ?? []).map((x) => { const p = Array.isArray(x.profiles) ? x.profiles[0] : x.profiles; return <tr key={x.user_id}><td>{p?.full_name}</td><td>{p?.phone}</td><td>{x.permissions.join(", ")}</td><td>{x.is_active ? "active" : "removed"}</td></tr>; })}
        {!staff?.length && <tr><td className="muted">Only the owner.</td></tr>}</tbody></table>

      <h2>Recent orders</h2>
      <table><tbody>{(orders ?? []).map((o) => <tr key={o.tracking_number}><td>{when(o.created_at)}</td><td><Link href={`/orders/${o.tracking_number}`}>{o.tracking_number}</Link></td><td>{o.recipient_name}</td><td>{statusText(o.status)}</td><td>{ghs(o.quoted_fee)}</td><td>{o.cod_amount ? `COD ${ghs(o.cod_amount)}` : ""}</td></tr>)}</tbody></table>
    </>
  );
}
