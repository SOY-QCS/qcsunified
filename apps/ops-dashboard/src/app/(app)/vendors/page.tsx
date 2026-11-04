import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity } from "@/lib/ops";
import { CityPicker } from "@/components/run";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Businesses that send with QCS: verification, account controls and services at a glance. */
export default async function Vendors({ searchParams }: PageProps<"/vendors">) {
  const me = await requireRole(["super_admin", "city_admin", "support", "analyst", "finance"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, sp.city, global);
  const q = one(sp.q).replace(/[^\w\s+@.-]/g, "").trim();
  const flag = one(sp.flag);
  let query = sb.from("vendors").select("id, business_name, account_type, contact_phone, kyc_status, booking_blocked, cod_payout_on_hold, cs_service_enabled, fulfilment_enabled, crm_stage, created_at, cities(name)")
    .not("owner_id", "is", null).order("business_name").limit(300);
  if (city) query = query.eq("city_id", city.id);
  if (q) query = query.or(`business_name.ilike.%${q}%,contact_phone.ilike.%${q}%,contact_email.ilike.%${q}%`);
  if (flag === "kyc") query = query.eq("kyc_status", "pending");
  if (flag === "blocked") query = query.or("booking_blocked.eq.true,cod_payout_on_hold.eq.true");
  if (flag === "churn") query = query.eq("crm_stage", "churn_risk");
  const { data: vendors, error } = await query;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Vendors</h1><CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      <form className="row" style={{ margin: "12px 0", alignItems: "end" }}>
        {city && <input type="hidden" name="city" value={city.id} />}
        <div><label>Search</label><input name="q" defaultValue={q} placeholder="Business, phone or email" /></div>
        <div><label>Show</label><select name="flag" defaultValue={flag}><option value="">All</option><option value="kyc">ID check waiting</option><option value="blocked">Blocked / COD on hold</option><option value="churn">Churn risk</option></select></div>
        <div style={{ flex: "0 0 auto" }}><button className="btn">Filter</button></div>
      </form>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead><tr><th>Business</th><th>City</th><th>ID check</th><th>Services</th><th>Flags</th></tr></thead>
        <tbody>
          {(vendors ?? []).map((v) => (
            <tr key={v.id}>
              <td><Link href={`/vendors/${v.id}`}><strong>{v.business_name}</strong></Link><br /><span className="muted">{v.account_type} · {v.contact_phone}</span></td>
              <td>{(Array.isArray(v.cities) ? v.cities[0] : v.cities)?.name ?? "—"}</td>
              <td>{v.kyc_status}</td>
              <td>{[v.cs_service_enabled && "customer service", v.fulfilment_enabled && "fulfilment"].filter(Boolean).join(", ") || <span className="muted">delivery</span>}</td>
              <td>{v.booking_blocked && <span className="tag">bookings blocked</span>}{v.cod_payout_on_hold && <span className="tag">COD on hold</span>}{v.crm_stage === "churn_risk" && <span className="tag">churn risk</span>}</td>
            </tr>
          ))}
          {!vendors?.length && <tr><td colSpan={5} className="muted">No vendors match.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
