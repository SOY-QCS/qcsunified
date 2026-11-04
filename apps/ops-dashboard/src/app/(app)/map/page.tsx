import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities, pickCity } from "@/lib/ops";
import { CityPicker } from "@/components/run";
import { LiveMap } from "./live-map";

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  const me = await requireRole(["super_admin", "city_admin", "dispatcher", "support", "analyst", "hub_manager"]);
  const sb = await supabaseServer();
  const { cities, global } = await myCities(sb, me);
  const city = pickCity(cities, (await searchParams).city, global);
  const { data: hubs } = await sb.rpc("hubs_overview", { p_city: city?.id ?? null });
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Live map</h1>
        <CityPicker cities={cities} value={city?.id ?? null} allowAll={global} />
      </div>
      <LiveMap city={city?.id ?? null} hubs={((hubs ?? []) as { id: string; name: string; code: string; lat: number; lng: number; is_active: boolean }[])
        .filter((h) => h.is_active).map((h) => ({ id: h.id, name: `${h.name} (${h.code})`, lat: h.lat, lng: h.lng }))} />
    </>
  );
}

