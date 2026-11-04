import "react-native-url-polyfill/auto";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** One Supabase client per app, with the login kept on the phone between launches. */
export function supabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "missing-anon-key";
  client = createClient(url, key, {
    auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
  // Only refresh the session while the app is open (saves battery and data).
  AppState.addEventListener("change", (s) => {
    if (s === "active") client!.auth.startAutoRefresh(); else client!.auth.stopAutoRefresh();
  });
  return client;
}

export interface Account {
  profile: { id: string; full_name: string; phone: string | null; email: string | null; city_id: string | null; marketing_opt_in: boolean } | null;
  roles: { role: string; city_id: string | null; hub_id: string | null; city_code: string | null; hub_code: string | null }[];
  vendor: { id: string; business_name: string; kyc_status: string; account_type: string } | null;
  rider: { status: string; rider_type: string; review_note: string | null; city_id: string } | null;
}

export async function loadAccount(): Promise<Account | null> {
  const { data, error } = await supabase().rpc("my_account");
  if (error) throw error;
  return data as Account;
}

export function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("rate limit") || m.includes("too many") || m.includes("security purposes")) return "Please wait a moment before asking for another code.";
  if (m.includes("expired") || m.includes("invalid") && m.includes("otp") || m.includes("token")) return "That code is wrong or has expired. Ask for a new one.";
  if (m.includes("network") || m.includes("fetch")) return "No internet connection. Check your data or Wi-Fi and try again.";
  if (m.includes("could not send")) return "We couldn't send the SMS right now. Please try again shortly.";
  return message;
}
