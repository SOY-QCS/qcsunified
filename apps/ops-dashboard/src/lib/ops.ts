import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPS_ROLES } from "@qcs/types";
import type { Staff } from "./session";

export interface City { id: string; code: string; name: string; same_day_cutoff: string; is_active: boolean }

/** Cities this staff member may work with. City-tied roles see only their city; Super Admin/Finance/Analyst see all. */
export async function myCities(sb: SupabaseClient, staff: Staff): Promise<{ cities: City[]; global: boolean }> {
  const { data } = await sb.from("cities").select("id, code, name, same_day_cutoff, is_active").order("name");
  const ops = staff.roles.filter((r) => (OPS_ROLES as readonly string[]).includes(r.role));
  const global = ops.some((r) => r.city_id == null);
  const mine = new Set(ops.map((r) => r.city_id).filter(Boolean));
  return { cities: ((data ?? []) as City[]).filter((c) => global || mine.has(c.id)), global };
}

/** The city picked in the page filter (?city=), limited to the ones this person may see. */
export function pickCity(cities: City[], wanted: string | string[] | undefined, global: boolean): City | null {
  const w = Array.isArray(wanted) ? wanted[0] : wanted;
  return cities.find((c) => c.id === w) ?? (global ? null : cities[0] ?? null);
}

export const has = (staff: Staff, ...roles: string[]) => staff.roles.some((r) => roles.includes(r.role));
export const ghs = (p: number | null | undefined) => (p == null ? "—" : `GHS ${(p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
export const statusText = (s: string) => s.replaceAll("_", " ").toLowerCase();
