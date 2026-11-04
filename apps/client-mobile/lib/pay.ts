import * as WebBrowser from "expo-web-browser";
import { api } from "./api";

/**
 * Pay through Hubtel: open Hubtel's page inside the app; when the person finishes, Hubtel sends them to
 * our return page, which bounces back into the app (qcs-client://payment). Then we ask the server for the result —
 * the app never decides a payment succeeded on its own.
 */
export async function payWithHubtel(body: { purpose: "order"; order_ids: string[] } | { purpose: "wallet_topup"; amount: number }): Promise<"paid" | "failed" | "pending" | "cancelled"> {
  const start = await api<{ client_reference: string; checkout_url: string }>("/api/v1/payments", { method: "POST", body: JSON.stringify({ ...body, app: true }) });
  const res = await WebBrowser.openAuthSessionAsync(start.checkout_url, "qcs-client://payment");
  for (let i = 0; i < 10; i++) {
    const s = await api<{ state: string }>(`/api/v1/payments/${start.client_reference}`).catch(() => ({ state: "pending" }));
    if (s.state === "paid") return "paid";
    if (s.state === "failed" || s.state === "expired") return "failed";
    if (s.state === "cancelled" || (res.type !== "success" && i >= 2)) return res.type === "cancel" || res.type === "dismiss" ? "cancelled" : "pending";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "pending";
}
