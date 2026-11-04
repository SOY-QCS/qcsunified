"use server";
import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";

export interface Result { ok: boolean; message: string }

/** Only a Super Admin can change wording (the database enforces it); every change is in the audit log. */
export async function saveTemplate(key: string, channel: string, v: { subject: string; body: string; wa_template: string; enabled: boolean }): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  if (!v.body.trim()) return { ok: false, message: "The message can't be empty" };
  const unknown = [...v.body.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]!).filter((k) => !/^[a-z_]+$/.test(k));
  if (unknown.length) return { ok: false, message: `Placeholders use small letters and _ only: ${unknown.join(", ")}` };
  const { data, error } = await (await supabaseServer()).from("notification_templates")
    .update({ subject: v.subject, body: v.body, wa_template: v.wa_template || null, enabled: v.enabled })
    .eq("key", key).eq("channel", channel).select("key");
  revalidatePath("/notifications");
  if (error) return { ok: false, message: error.message };
  if (!data?.length) return { ok: false, message: "Only a Super Admin can change messages" };
  return { ok: true, message: "Saved" };
}

export async function saveChannels(channels: string[], siteUrl: string, etaSpeed: number): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  if (!channels.length) return { ok: false, message: "Choose at least one way to reach recipients" };
  if (!/^https:\/\/[^\s/]+/.test(siteUrl)) return { ok: false, message: "Website address must start with https://" };
  if (!(etaSpeed >= 5 && etaSpeed <= 80)) return { ok: false, message: "Average speed must be 5–80 km/h" };
  const sb = await supabaseServer();
  for (const [key, value] of [["recipient_channels", channels], ["public_site_url", siteUrl.replace(/\/$/, "")], ["eta_speed_kmh", etaSpeed]] as const) {
    const { error } = await sb.from("app_settings").update({ value }).eq("key", key).is("city_id", null);
    if (error) return { ok: false, message: error.message };
  }
  revalidatePath("/notifications");
  return { ok: true, message: "Saved" };
}
