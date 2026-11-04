/**
 * Push notifications through Expo (free). Asks permission, gets this phone's Expo push token and saves it
 * for the signed-in person, so the database can send them job offers / delivery updates.
 * Works in development builds and store builds (needs the EAS project id); quietly does nothing in Expo Go.
 */
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { supabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function registerForPush(app: "client" | "rider"): Promise<string | null> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Delivery updates", importance: Notifications.AndroidImportance.DEFAULT });
      if (app === "rider") await Notifications.setNotificationChannelAsync("jobs", { name: "Job offers", importance: Notifications.AndroidImportance.MAX, sound: "default", vibrationPattern: [0, 400, 200, 400] });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return null;   // not set up with EAS yet (e.g. Expo Go)
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await supabase().rpc("register_push_token", { p_token: token, p_app: app, p_platform: Platform.OS });
    return token;
  } catch {
    return null;   // push is a bonus: the app works without it
  }
}

/** Call before signing out so this phone stops getting the previous person's messages. */
export async function unregisterPush(token: string | null) {
  if (token) await supabase().rpc("unregister_push_token", { p_token: token }).then(() => undefined, () => undefined);
}

/** Runs `onOpen(data)` when the person taps a notification (e.g. open the tracking screen). */
export function onNotificationTap(onOpen: (data: Record<string, unknown>) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => onOpen((r.notification.request.content.data ?? {}) as Record<string, unknown>));
  return () => sub.remove();
}
