import Link from "next/link";
import type { PricingRuleRow, WeightBand } from "@qcs/pricing";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { CutoffEditor, ExpressEditor, InsuranceEditor, LaneEditor, PromoCodeEditor, PromoEditor, ZoneEditor, type ExpressConfig, type PromoCodeRow } from "./editors";

const TABS = [
  { id: "express", label: "Express" },
  { id: "ecommerce", label: "E-commerce zones" },
  { id: "intercity", label: "Inter-city lanes" },
  { id: "offers", label: "Flat-rate offers" },
  { id: "codes", label: "Promo codes" },
  { id: "insurance", label: "Insurance" },
] as const;

export default async function PricingPage({ searchParams }: PageProps<"/pricing">) {
  const me = await requireRole(["super_admin", "city_admin", "finance"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [{ data: cities }, { data: zones }, { data: hubs }, { data: rules }, { data: settings }, { data: codes }] = await Promise.all([
    sb.from("cities").select("id, code, name, same_day_cutoff").order("name"),
    sb.from("zones").select("id, code, name, city_id").order("name"),
    sb.from("hubs").select("id, code, name, city_id").order("name"),
    sb.from("pricing_rules").select("*").order("created_at"),
    sb.from("app_settings").select("key, city_id, value").in("key", ["surge_multiplier", "night_window", "insurance_rate", "high_value_threshold"]),
    sb.from("promo_codes").select("*").order("created_at", { ascending: false }),
  ]);

  const isGlobal = me.roles.some((r) => r.role === "super_admin" || r.role === "finance");
  const myCities = (cities ?? []).filter((c) => isGlobal || me.roles.some((r) => r.role === "city_admin" && r.city_id === c.id));
  const city = myCities.find((c) => c.code === sp.city) ?? myCities[0];
  if (!city) return <><h1>Pricing</h1><div className="card muted">No city assigned to you.</div></>;
  const tab = (TABS.find((t) => t.id === sp.tab) ?? TABS[0]).id;
  const all = (rules ?? []) as (PricingRuleRow & { name: string })[];
  const setting = (key: string) => (settings ?? []).find((s) => s.key === key && s.city_id === city.id)?.value ?? (settings ?? []).find((s) => s.key === key && !s.city_id)?.value;
  const express = all.find((r) => r.rule_kind === "express" && r.city_id === city.id && !r.zone_id);
  const cityZones = (zones ?? []).filter((z) => z.city_id === city.id);
  const cityHubs = (hubs ?? []).filter((h) => h.city_id === city.id);
  const href = (o: { city?: string; tab?: string }) => `/pricing?city=${o.city ?? city.code}&tab=${o.tab ?? tab}`;

  return (
    <>
      <h1>Pricing</h1>
      <p className="muted">Prices are in Ghana cedis. Changes apply to new quotes immediately and are recorded in the audit log. Quotes already given stay locked.</p>
      <div className="tabs" style={{ flexWrap: "wrap" }}>
        {myCities.map((c) => <Link key={c.id} className={`btn small ${c.id === city.id ? "" : "secondary"}`} href={href({ city: c.code })}>{c.name}</Link>)}
      </div>
      <div className="tabs" style={{ flexWrap: "wrap", margin: "10px 0 16px" }}>
        {TABS.map((t) => <Link key={t.id} className={`btn small ${t.id === tab ? "" : "secondary"}`} href={href({ tab: t.id })}>{t.label}</Link>)}
      </div>

      {tab === "express" && (
        <ExpressEditor key={city.id} ruleId={express?.id ?? null} cityId={city.id} cityName={city.name} config={(express?.config as ExpressConfig) ?? null}
          surge={Number(setting("surge_multiplier") ?? 1)} night={(setting("night_window") as { start: string; end: string }) ?? { start: "20:00", end: "06:00" }} canEdit />
      )}

      {tab === "ecommerce" && (
        <>
          <CutoffEditor key={`c-${city.id}`} cityId={city.id} cutoff={city.same_day_cutoff} canEdit />
          <p className="muted">Price per delivered stop by weight, for each drop-off zone. Tap a zone to edit.</p>
          {cityZones.map((z) => {
            const r = all.find((x) => x.rule_kind === "ecommerce_zone" && x.zone_id === z.id);
            return <ZoneEditor key={z.id} ruleId={r?.id ?? null} cityId={city.id} zone={z} bands={(r?.config as { bands: WeightBand[] } | undefined)?.bands ?? null} canEdit />;
          })}
          {cityZones.length === 0 && <div className="card muted">No zones in this city yet.</div>}
        </>
      )}

      {tab === "intercity" && (
        <>
          <p className="muted">Lanes leaving {city.name}. Price by weight from hub to hub; add the doorstep fee when the customer wants delivery at the other end.</p>
          {cityHubs.flatMap((from) => (hubs ?? []).filter((to) => to.id !== from.id).map((to) => {
            const r = all.find((x) => x.rule_kind === "intercity_lane" && x.origin_hub_id === from.id && x.dest_hub_id === to.id);
            return <LaneEditor key={`${from.id}-${to.id}`} ruleId={r?.id ?? null} cityId={city.id} from={from} to={to}
              config={(r?.config as { bands: WeightBand[]; doorstepFee: number }) ?? null} canEdit />;
          }))}
        </>
      )}

      {tab === "codes" && (
        <PromoCodeEditor key={`pc-${city.id}`} cityId={city.id} canEdit codes={((codes ?? []) as (PromoCodeRow & { city_id: string | null })[]).filter((c) => !c.city_id || c.city_id === city.id)} />
      )}

      {tab === "insurance" && (
        <InsuranceEditor rate={Number(setting("insurance_rate") ?? 0.05)} threshold={Number(setting("high_value_threshold") ?? 100000)} canEdit={isGlobal} />
      )}

      {tab === "offers" && (
        <PromoEditor key={`p-${city.id}`} cityId={city.id} zones={cityZones} canEdit
          promos={all.filter((r) => r.rule_kind === "flat_promo" && r.city_id === city.id).map((r) => ({
            id: r.id, name: r.name, zone_id: r.zone_id, flatFee: (r.config as { flatFee: number }).flatFee, valid_from: r.valid_from, valid_to: r.valid_to, is_active: r.is_active,
          }))} />
      )}
    </>
  );
}
