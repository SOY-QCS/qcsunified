import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { HubEditor, type Hub } from "./hub-editor";

/** Hubs: address, map pin, hours, capacity, staff and parcels in the building now. */
export default async function Hubs({ searchParams }: PageProps<"/hubs">) {
  const me = await requireRole(["super_admin", "city_admin", "hub_manager", "analyst", "dispatcher"]);
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, (await searchParams).city, global);
  const { data } = await sb.rpc("hubs_overview", { p_city: city?.id ?? null });
  const adminOf = cities.filter((c) => me.roles.some((r) => r.role === "super_admin" || (r.role === "city_admin" && r.city_id === c.id)));
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Hubs</h1><CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      <p className="muted">Staff are linked to a hub on the Staff &amp; roles page (Hub Manager / Hub Handler with a hub).</p>
      <HubEditor hubs={(data ?? []) as Hub[]} cities={cities.map((c) => ({ id: c.id, name: c.name }))} editable={adminOf.map((c) => c.id)} defaultCity={city?.id ?? adminOf[0]?.id ?? ""} />
    </>
  );
}
