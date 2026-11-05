import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, when } from "@/lib/ops";
import { STAGES } from "@/lib/sla";
import { NoteBox } from "@/components/crm";
import { CRM_ROLES, CrmTabs, one } from "../../tabs";
import { LeadForm, MoveLead } from "../lead-form";

export default async function LeadPage({ params }: PageProps<"/crm/leads/[id]">) {
  const me = await requireRole([...CRM_ROLES]);
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: l } = await sb.from("leads").select("*, vendors(id, business_name, crm_stage)").eq("id", id).maybeSingle();
  if (!l) notFound();
  const [{ data: notes }, { data: staff }, { cities }] = await Promise.all([
    sb.from("crm_notes").select("id, body, created_at, profiles!crm_notes_author_id_fkey(full_name)").eq("lead_id", id).order("created_at", { ascending: false }),
    sb.from("user_roles").select("user_id, profiles!user_roles_user_id_fkey(full_name)").in("role", ["super_admin", "city_admin", "support"]),
    myCities(sb, me),
  ]);
  const owners = [...new Map((staff ?? []).map((r) => [r.user_id, one(r.profiles)?.full_name ?? "Staff"])).entries()].map(([k, name]) => ({ id: k, name }));
  const v = one(l.vendors);
  const canEdit = has(me, "super_admin", "city_admin", "support");
  return (
    <>
      <p><Link href="/crm/leads">← Leads</Link></p>
      <h1>{l.business_name} <span className="tag">{STAGES.find(([k]) => k === l.stage)?.[1]}</span></h1>
      <CrmTabs at="/crm/leads" />
      <p>{l.contact_name} · {l.phone} · {l.email} · added {when(l.created_at)}{l.lost_reason ? ` · lost: ${l.lost_reason}` : ""}</p>
      {v && <p>Signed up as vendor: <Link href={`/vendors/${v.id}`}>{v.business_name}</Link> (stage follows the vendor automatically)</p>}
      {canEdit && <div className="card"><MoveLead id={id} stage={l.stage} hasVendor={!!v} /></div>}
      {canEdit && <div className="card"><LeadForm id={id} cities={cities.map((c) => ({ id: c.id, name: c.name }))} owners={owners} me={me.id} v={{
        business_name: l.business_name, contact_name: l.contact_name ?? "", phone: l.phone ?? "", email: l.email ?? "", city_id: l.city_id ?? "",
        source: l.source, owner_id: l.owner_id ?? "", expected_weekly: l.expected_weekly?.toString() ?? "", next_action: l.next_action ?? "", next_action_at: l.next_action_at ?? "" }} /></div>}
      <h2>Timeline</h2>
      {canEdit && <NoteBox subject="lead" id={id} />}
      {(notes ?? []).map((n) => <div key={n.id} className="card" style={{ padding: 10 }}><div className="muted">{one(n.profiles)?.full_name} · {when(n.created_at)}</div>{n.body}</div>)}
    </>
  );
}
