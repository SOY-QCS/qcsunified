import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, pickCity } from "@/lib/ops";
import { STAGES } from "@/lib/sla";
import { CityPicker } from "@/components/run";
import { CRM_ROLES, CrmTabs, one } from "../tabs";
import { LeadForm } from "./lead-form";

/** Vendor acquisition pipeline: New → Contacted → Trial → Active → Churn risk (and Lost). */
export default async function Leads({ searchParams }: PageProps<"/crm/leads">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const showLost = sp.lost === "1";
  let q = sb.from("leads").select("id, business_name, contact_name, phone, stage, source, expected_weekly, next_action, next_action_at, vendor_id, owner:profiles!leads_owner_id_fkey(full_name)")
    .order("updated_at", { ascending: false }).limit(500);
  if (city) q = q.eq("city_id", city.id);
  if (!showLost) q = q.not("stage", "in", "(lost,churned)");
  const [{ data: leads, error }, { data: staff }] = await Promise.all([
    q, sb.from("user_roles").select("user_id, profiles!user_roles_user_id_fkey(full_name)").in("role", ["super_admin", "city_admin", "support"]),
  ]);
  const owners = [...new Map((staff ?? []).map((r) => [r.user_id, one(r.profiles)?.full_name ?? "Staff"])).entries()].map(([id, name]) => ({ id, name }));
  const today = new Date().toISOString().slice(0, 10);
  const cols = STAGES.filter(([k]) => showLost || !["lost", "churned"].includes(k));
  return (
    <>
      <h1>Leads</h1>
      <CrmTabs at="/crm/leads" />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
        <Link className="btn small secondary" href={showLost ? "/crm/leads" : "/crm/leads?lost=1"}>{showLost ? "Hide lost & churned" : "Show lost & churned"}</Link>
      </div>
      {error && <p className="error">{error.message}</p>}
      <div className="board">
        {cols.map(([k, label]) => {
          const list = (leads ?? []).filter((l) => l.stage === k);
          return (
            <div key={k} className="col">
              <h3>{label} <span className="muted">({list.length})</span></h3>
              {list.map((l) => (
                <Link key={l.id} href={`/crm/leads/${l.id}`} className="lead">
                  <strong>{l.business_name}</strong>{l.vendor_id && <span className="tag" style={{ marginLeft: 6 }}>vendor</span>}
                  <div className="muted">{l.contact_name ?? ""} {l.phone ?? ""}</div>
                  {l.expected_weekly ? <div className="muted">~{l.expected_weekly} parcels/week · {l.source}</div> : <div className="muted">{l.source}</div>}
                  {l.next_action && <div style={{ color: l.next_action_at && l.next_action_at <= today ? "var(--danger)" : undefined }}>→ {l.next_action}{l.next_action_at ? ` (${l.next_action_at})` : ""}</div>}
                  <div className="muted">{one(l.owner)?.full_name ?? ""}</div>
                </Link>
              ))}
            </div>
          );
        })}
      </div>
      {has(me, "super_admin", "city_admin", "support") && <>
        <h2>New lead</h2>
        <div className="card" style={{ maxWidth: 720 }}><LeadForm cities={cities.map((c) => ({ id: c.id, name: c.name }))} owners={owners} me={me.id} /></div>
      </>}
      <p className="muted">When a lead signs up as a vendor with the same phone number, it is linked automatically and moves to Trial. Trial → Active after 5 deliveries; Active → Churn risk when weekly volume drops 30%+ (checked every morning).</p>
    </>
  );
}
