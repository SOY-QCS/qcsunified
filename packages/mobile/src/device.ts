/**
 * Tells QCS which phone this account signed in on, using the phone's own app ID
 * (Android ID / iOS "identifier for vendor", via expo-application — free, part of Expo).
 * It survives reinstalling the app, so one phone creating many accounts can be spotted (fraud check).
 * It is not the phone number or IMEI, and it identifies the phone only to QCS's apps.
 */
import { Platform } from "react-native";
import * as Application from "expo-application";
import { supabase } from "./supabase";

export async function phoneId(): Promise<string | null> {
  try {
    if (Platform.OS === "android") return Application.getAndroidId() || null;
    if (Platform.OS === "ios") return await Application.getIosIdForVendorAsync();
  } catch { /* not available (e.g. web preview) */ }
  return null;
}

/** Call once after sign-in. Never blocks or breaks the app if it fails. */
export async function registerDevice(app: "client" | "rider"): Promise<void> {
  const id = await phoneId();
  if (!id) return;
  const model = (Platform.constants as { Model?: string } | undefined)?.Model ?? null;
  await supabase().rpc("register_device", { p_device: id, p_app: app, p_platform: Platform.OS, p_model: model }).then(() => undefined, () => undefined);
}
