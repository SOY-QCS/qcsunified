import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { when } from "@/lib/ops";
import { CRM_ROLES, CrmTabs } from "../tabs";

/** Find a customer by name, phone or email → their 360 profile. Vendors have their own page under Vendors. */
export default async function Customers({ searchParams }: PageProps<"/crm/customers">) {
  await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim();
  const sb = await supabaseServer();
  let rows: { id: string; full_name: string | null; phone: string | null; email: string | null; created_at: string }[] = [];
  let vendors: { id: string; business_name: string; contact_phone: string | null }[] = [];
  if (q.length >= 3) {
    const safe = q.replace(/[%,()]/g, "");
    const digits = q.replace(/\D/g, "").replace(/^0/, "");
    const cond = [`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`, digits.length >= 4 && `phone.ilike.%${digits}%`].filter(Boolean).join(",");
    const [p, v] = await Promise.all([
      sb.from("profiles").select("id, full_name, phone, email, created_at").or(cond).order("created_at", { ascending: false }).limit(30),
      sb.from("vendors").select("id, business_name, contact_phone").or([`business_name.ilike.%${safe}%`, digits.length >= 4 && `contact_phone.ilike.%${digits}%`].filter(Boolean).join(",")).limit(10),
    ]);
    rows = p.data ?? []; vendors = v.data ?? [];
  }
  return (
    <>
      <h1>Customers</h1>
      <CrmTabs at="/crm/customers" />
      <form className="row" style={{ alignItems: "end", maxWidth: 560 }}>
        <div><label>Name, phone or email</label><input name="q" defaultValue={q} autoFocus /></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn">Search</button></div>
      </form>
      {q && q.length < 3 && <p className="muted">Type at least 3 characters.</p>}
      {vendors.length > 0 && <><h2>Vendors</h2><table><tbody>{vendors.map((v) => <tr key={v.id}><td><Link href={`/vendors/${v.id}`}>{v.business_name}</Link></td><td>{v.contact_phone}</td></tr>)}</tbody></table></>}
      {q.length >= 3 && <><h2>People</h2><table><tbody>
        {rows.map((r) => <tr key={r.id}><td><Link href={`/crm/customers/${r.id}`}>{r.full_name ?? "(no name)"}</Link></td><td>{r.phone}</td><td>{r.email}</td><td className="muted">joined {when(r.created_at)}</td></tr>)}
        {!rows.length && <tr><td className="muted">Nobody found in your cities.</td></tr>}
      </tbody></table></>}
    </>
  );
}
