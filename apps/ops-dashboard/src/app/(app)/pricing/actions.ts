"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FlatPromoRule, NightWindow, RULE_SCHEMAS, Surge, type RuleKind } from "@qcs/pricing";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";

export interface Result { ok: boolean; message: string }
const done = (message: string): Result => { revalidatePath("/pricing"); return { ok: true, message }; };
const fail = (message: string): Result => ({ ok: false, message });

/**
 * Save one price rule. The config is checked against the same rules the pricing engine uses,
 * and the database decides who may save it (City Admin for their city, Finance, Super Admin).
 * Every change lands in the audit log automatically.
 */
export async function saveRule(input: { id?: string; kind: RuleKind; name: string; city_id: string | null; zone_id?: string | null;
  origin_hub_id?: string | null; dest_hub_id?: string | null; config: unknown }): Promise<Result> {
  if (!(await getStaff())) return fail("Not signed in");
  const schema = RULE_SCHEMAS[input.kind];
  const parsed = schema.safeParse(input.config);
  if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
  const sb = await supabaseServer();
  const row = { rule_kind: input.kind, name: input.name, city_id: input.city_id, zone_id: input.zone_id ?? null,
    origin_hub_id: input.origin_hub_id ?? null, dest_hub_id: input.dest_hub_id ?? null, config: parsed.data };
  const { data, error } = input.id
    ? await sb.from("pricing_rules").update({ config: parsed.data }).eq("id", input.id).select("id")
    : await sb.from("pricing_rules").insert(row).select("id");
  if (error) return fail(error.message);
  if (!data?.length) return fail("You don't have permission to change prices here.");
  return done("Saved. New quotes use this price straight away.");
}

export async function saveCutoff(cityId: string, cutoff: string): Promise<Result> {
  if (!/^\d{2}:\d{2}$/.test(cutoff)) return fail("Use a time like 09:00");
  const sb = await supabaseServer();
  const { error } = await sb.rpc("set_city_cutoff", { p_city: cityId, p_cutoff: cutoff });
  return error ? fail(error.message) : done(`Same-day cut-off is now ${cutoff}.`);
}

/** Surge and night window are stored per city (falling back to the platform default). */
export async function saveCitySetting(cityId: string, key: "surge_multiplier" | "night_window", value: unknown): Promise<Result> {
  const check = key === "surge_multiplier" ? Surge.safeParse(value) : NightWindow.safeParse(value);
  if (!check.success) return fail(key === "surge_multiplier" ? "Surge must be between 1.0 and 3.0" : "Use times like 20:00 and 06:00");
  const sb = await supabaseServer();
  const { data: existing } = await sb.from("app_settings").select("key").eq("key", key).eq("city_id", cityId).maybeSingle();
  const { error } = existing
    ? await sb.from("app_settings").update({ value: check.data }).eq("key", key).eq("city_id", cityId)
    : await sb.from("app_settings").insert({ key, city_id: cityId, value: check.data, description: key === "surge_multiplier" ? "Busy-time multiplier" : "Night surcharge window" });
  return error ? fail(error.message) : done("Saved.");
}

const PromoInput = z.object({
  name: z.string().trim().min(3, "Give the offer a name"),
  city_id: z.uuid(), zone_id: z.uuid().nullable(),
  flatFee: z.number().int().positive("Enter the flat price"),
  valid_from: z.iso.datetime(), valid_to: z.iso.datetime(),
}).refine((p) => p.valid_to > p.valid_from, "The end date must be after the start date");

export async function createFlatPromo(input: z.input<typeof PromoInput>): Promise<Result> {
  const p = PromoInput.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]!.message);
  const sb = await supabaseServer();
  const { error } = await sb.from("pricing_rules").insert({
    rule_kind: "flat_promo", name: p.data.name, city_id: p.data.city_id, zone_id: p.data.zone_id,
    config: FlatPromoRule.parse({ flatFee: p.data.flatFee }), valid_from: p.data.valid_from, valid_to: p.data.valid_to, is_active: true,
  });
  return error ? fail(error.message) : done("Offer created.");
}

export async function setRuleActive(id: string, active: boolean): Promise<Result> {
  const sb = await supabaseServer();
  const { data, error } = await sb.from("pricing_rules").update({ is_active: active }).eq("id", id).select("id");
  if (error) return fail(error.message);
  if (!data?.length) return fail("You don't have permission to change this.");
  return done(active ? "Switched on." : "Switched off.");
}

/** Platform-wide insurance settings (Finance / Super Admin; the database enforces this). */
export async function saveInsurance(rate: number, thresholdPesewas: number): Promise<Result> {
  if (!(rate > 0 && rate <= 0.5)) return fail("Premium must be between 0.01% and 50%");
  if (!(Number.isInteger(thresholdPesewas) && thresholdPesewas > 0)) return fail("Enter the high-value threshold in GHS");
  const sb = await supabaseServer();
  for (const [key, value] of [["insurance_rate", rate], ["high_value_threshold", thresholdPesewas]] as const) {
    const { data, error } = await sb.from("app_settings").update({ value }).eq("key", key).is("city_id", null).select("key");
    if (error) return fail(error.message);
    if (!data?.length) return fail("Only Finance or a Super Admin can change insurance.");
  }
  return done("Insurance settings saved.");
}
