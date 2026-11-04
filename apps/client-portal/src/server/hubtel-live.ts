import "server-only";
import { hubtel } from "@qcs/api-client";
import { serviceClient, ApiError } from "./supabase";
import type { CallbackDeps } from "./payments";

export const hubtelCfg = () => hubtel.hubtelConfig(process.env);
/** Public address of this server (Hubtel must be able to reach it). */
export const publicUrl = () => (process.env.PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
/** Local testing only: pretend checkout when Hubtel keys aren't set. Never on in production. */
export const fakePayments = () => process.env.DEV_FAKE_PAYMENTS === "1" && process.env.NODE_ENV !== "production";

export function callbackDeps(): CallbackDeps {
  const db = serviceClient();
  const cfg = hubtelCfg();
  return {
    expectedToken: process.env.HUBTEL_CALLBACK_TOKEN,
    record: async (ref, dedupe, payload) => {
      const { data, error } = await db.rpc("record_payment_event", { p_ref: ref, p_source: "checkout_callback", p_dedupe: dedupe, p_payload: payload });
      if (error) throw error;
      return data as boolean;
    },
    statusCheck: async (ref) => (cfg ? hubtel.checkTransactionStatus(cfg, ref) : null),
    settle: async (ref, chk, amount, txn, channel, phone) => {
      const { data, error } = await db.rpc("settle_payment", { p_ref: ref, p_checkout_id: chk, p_amount: amount, p_txn: txn, p_channel: channel, p_phone: phone });
      if (error) throw new Error(error.message);
      return data as string;
    },
    fail: async (ref, reason) => { await db.rpc("fail_payment", { p_ref: ref, p_reason: reason }); },
  };
}

export function requireHubtel() {
  const cfg = hubtelCfg();
  if (!cfg) throw new ApiError(503, "Online payment isn't switched on yet. Please pay with your wallet or cash.");
  if (!process.env.HUBTEL_CALLBACK_TOKEN) throw new ApiError(500, "HUBTEL_CALLBACK_TOKEN is not set");
  return cfg;
}
