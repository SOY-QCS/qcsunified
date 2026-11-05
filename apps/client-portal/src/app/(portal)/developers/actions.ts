"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

export type R = { ok: boolean; message: string; data?: unknown };
const done = (error: { message: string } | null, msg: string, data?: unknown): R => {
  revalidatePath("/developers");
  return error ? { ok: false, message: error.message } : { ok: true, message: msg, data };
};

/** Make an API key. The full key comes back once (shown on screen, never stored). The database checks permission and the ID check for live keys. */
export async function createKey(vendorId: string, name: string, mode: "test" | "live"): Promise<R> {
  const { data, error } = await (await supabaseServer()).rpc("create_api_key", { p_vendor: vendorId, p_name: name, p_mode: mode });
  return done(error, "Key created", data);
}

export async function revokeKey(id: string): Promise<R> {
  const { error } = await (await supabaseServer()).rpc("revoke_api_key", { p_id: id });
  return done(error, "Key revoked — calls with it now fail");
}

const Hook = z.object({
  url: z.string().trim().url("Enter a full address starting with https://").startsWith("https://", "Webhooks must use https://"),
  mode: z.enum(["live", "test"]),
  events: z.array(z.enum(["*", "delivery.created", "delivery.status_changed"])).min(1),
  description: z.string().trim().max(100).optional(),
});

export async function addWebhook(vendorId: string, input: z.input<typeof Hook>): Promise<R> {
  const p = Hook.safeParse(input);
  if (!p.success) return { ok: false, message: p.error.issues[0]!.message };
  const { error } = await (await supabaseServer()).from("webhooks").insert({ vendor_id: vendorId, ...p.data, description: p.data.description || null });
  return done(error && { message: error.message.includes("row-level") ? "You don't have API access for this business" : error.message }, "Webhook added — send a test event to check it");
}

export async function setWebhookActive(id: string, active: boolean): Promise<R> {
  const { data, error } = await (await supabaseServer()).from("webhooks").update({ is_active: active }).eq("id", id).select("id");
  return done(error ?? (data?.length ? null : { message: "Not allowed" }), active ? "Turned on" : "Turned off");
}

export async function deleteWebhook(id: string): Promise<R> {
  const { data, error } = await (await supabaseServer()).from("webhooks").delete().eq("id", id).select("id");
  return done(error ?? (data?.length ? null : { message: "Not allowed" }), "Webhook deleted");
}

export async function rotateSecret(id: string): Promise<R> {
  const { data, error } = await (await supabaseServer()).rpc("rotate_webhook_secret", { p_id: id });
  return done(error, "New secret made — update it in your system now; the old one no longer signs messages", data);
}

export async function pingWebhook(id: string): Promise<R> {
  const { error } = await (await supabaseServer()).rpc("ping_webhook", { p_id: id });
  return done(error, "Test event queued — it is sent within a few seconds; refresh to see the result below");
}

export async function resendDelivery(id: string): Promise<R> {
  const { error } = await (await supabaseServer()).rpc("resend_webhook", { p_id: id });
  return done(error, "Queued to send again");
}

export async function saveShopifySettings(shop: string, s: { service: "ecommerce" | "express"; auto_create: boolean }): Promise<R> {
  const { data, error } = await (await supabaseServer()).from("shopify_shops").update(s).eq("shop", shop).select("shop");
  return done(error ?? (data?.length ? null : { message: "Not allowed" }), "Saved");
}
