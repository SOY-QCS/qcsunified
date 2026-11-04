import * as WebBrowser from "expo-web-browser";
import { supabase } from "@qcs/mobile";

/** The QCS server (business portal API). Set EXPO_PUBLIC_API_URL, e.g. http://192.168.1.20:3001 while testing. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase().auth.getSession();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}), ...(init?.headers ?? {}) } });
  } catch {
    throw new Error("No internet connection. Try again when you have data.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
  return body as T;
}

/** Hand in COD cash by MoMo through Hubtel. The server, not the app, decides when it's paid. */
export async function remitByMomo(orderIds: string[]): Promise<"paid" | "failed" | "pending" | "cancelled"> {
  const start = await api<{ client_reference: string; checkout_url: string }>("/api/v1/rider/cod-remit", { method: "POST", body: JSON.stringify({ order_ids: orderIds }) });
  const res = await WebBrowser.openAuthSessionAsync(start.checkout_url, "qcs-rider://payment");
  for (let i = 0; i < 10; i++) {
    const s = await api<{ state: string }>(`/api/v1/payments/${start.client_reference}`).catch(() => ({ state: "pending" }));
    if (s.state === "paid") return "paid";
    if (s.state === "failed" || s.state === "expired") return "failed";
    if (s.state === "cancelled" || (res.type !== "success" && i >= 2)) return res.type === "cancel" || res.type === "dismiss" ? "cancelled" : "pending";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "pending";
}
