import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities, pickCity } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { ZoneEditor, type ZoneRow } from "./zone-editor";
import { CityEditor } from "./city-editor";
import { CityPause } from "./pause";

/** Cities and their delivery zones. Zones decide e-commerce prices and which areas we serve. */
export default async function Zones({ searchParams }: PageProps<"/zones">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "analyst", "finance"]);
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, (await searchParams).city, false) ?? cities[0] ?? null;
  const { data: zones } = city ? await sb.rpc("zones_geojson", { p_city: city.id }) : { data: [] };
  const { data: hubs } = city ? await sb.rpc("hubs_overview", { p_city: city.id }) : { data: [] };
  const { data: pause } = city ? await sb.from("cities").select("bookings_paused_until, pause_message").eq("id", city.id).maybeSingle() : { data: null };
  const canEdit = city ? me.roles.some((r) => r.role === "super_admin" || (r.role === "city_admin" && r.city_id === city.id)) : false;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Cities &amp; zones{city ? ` — ${city.name}` : ""}</h1>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={false} />
      </div>
      {city && <CityPause cityId={city.id} cityName={city.name} pausedUntil={pause?.bookings_paused_until ?? null} message={pause?.pause_message ?? null} canEdit={canEdit} />}
      {city && <ZoneEditor cityId={city.id} cityCode={city.code} zones={(zones ?? []) as ZoneRow[]} canEdit={canEdit}
        hubs={((hubs ?? []) as { id: string; name: string; lat: number; lng: number }[]).map((h) => ({ id: h.id, name: h.name, lat: h.lat, lng: h.lng }))} />}
      {global && has(me, "super_admin") && <CityEditor cities={cities} />}
    </>
  );
}
