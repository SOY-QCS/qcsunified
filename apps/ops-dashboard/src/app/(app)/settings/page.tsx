import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, myCities } from "@/lib/ops";
import { SettingRow } from "./setting-row";

// Pricing knobs are on the Pricing page and message wording on Messages; this page is everything else.
const ELSEWHERE = new Set(["surge_multiplier", "night_window", "insurance_rate", "high_value_threshold", "uninsured_lost_multiplier",
  "recipient_channels", "public_site_url", "eta_speed_kmh"]);

/** Every operational setting: the default for all cities, and per-city overrides. */
export default async function Settings() {
  const me = await requireRole(["super_admin", "city_admin", "analyst"]);
  const sb = await supabaseServer();
  const { cities } = await myCities(sb, me);
  const { data } = await sb.from("app_settings").select("key, city_id, value, description, updated_at").order("key");
  const rows = (data ?? []).filter((s) => !ELSEWHERE.has(s.key));
  const defaults = rows.filter((s) => s.city_id == null);
  const adminCities = cities.filter((c) => me.roles.some((r) => r.role === "super_admin" || (r.role === "city_admin" && r.city_id === c.id)));
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">The default applies to every city. A city can have its own value, which wins for that city. {has(me, "super_admin") ? "" : "Only a Super Admin can change defaults; City Admins can set their own city."} Every change is in the audit log.</p>
      <table>
        <thead><tr><th style={{ width: "34%" }}>Setting</th><th>Default</th>{adminCities.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
        <tbody>
          {defaults.map((d) => (
            <SettingRow key={d.key} k={d.key} description={d.description} value={d.value} canDefault={has(me, "super_admin")}
              cities={adminCities.map((c) => ({ id: c.id, value: rows.find((r) => r.key === d.key && r.city_id === c.id)?.value ?? null }))} />
          ))}
        </tbody>
      </table>
    </>
  );
}
