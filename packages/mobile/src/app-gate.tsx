/**
 * Wraps the whole app:
 *  - "Please update" screen when this version is older than the minimum set in Ops → Settings (app_min_version_…);
 *  - banners for a city where bookings are paused, a general notice, or a newer version in the store;
 *  - quietly downloads quick fixes published with `eas update` (applied the next time the app opens).
 * Checks at start-up and whenever the app comes back to the screen (at most every 10 minutes). Works before sign-in.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { colors } from "@qcs/ui";
import { Button, s } from "./kit";
import { supabase } from "./supabase";

type Status = {
  update_required: boolean; update_available: boolean; store_url: string | null; notice: string | null;
  pauses: { city_id: string; city: string; until: string; text: string }[];
};

export const appVersion = () => Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0";
const RECHECK_MS = 10 * 60 * 1000;

export function AppGate({ app, children }: { app: "client" | "rider"; children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [hideUpdate, setHideUpdate] = useState(false);
  const last = useRef(0);

  const check = useCallback(async () => {
    if (Date.now() - last.current < RECHECK_MS) return;
    last.current = Date.now();
    const { data } = await supabase().rpc("app_status", { p_app: app, p_version: appVersion(), p_platform: Platform.OS });
    if (data) setStatus(data as Status);
    // quick fixes (EAS Update): download now, used next time the app starts. Never blocks anyone.
    if (Updates.isEnabled && !__DEV__) {
      try { const u = await Updates.checkForUpdateAsync(); if (u.isAvailable) await Updates.fetchUpdateAsync(); } catch { /* offline: try next time */ }
    }
  }, [app]);

  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") check(); });
    return () => sub.remove();
  }, [check]);

  if (status?.update_required) {
    return (
      <SafeAreaView style={[s.safe, { justifyContent: "center", padding: 24 }]}>
        <Text style={s.title}>Please update {app === "rider" ? "QCS Rider" : "QCS"}</Text>
        <Text style={[s.sub, { marginBottom: 24 }]}>This version ({appVersion()}) is no longer supported. The update takes a minute and keeps your account and history.</Text>
        {status.store_url && <Button title="Update now" onPress={() => Linking.openURL(status.store_url!)} />}
      </SafeAreaView>
    );
  }

  const lines = [
    ...(status?.pauses ?? []).map((p) => ({ key: p.city_id, text: p.text, strong: true })),
    ...(status?.notice ? [{ key: "notice", text: status.notice, strong: false }] : []),
  ];
  return (
    <View style={{ flex: 1 }}>
      {(lines.length > 0 || (status?.update_available && !hideUpdate)) && (
        <SafeAreaView edges={["top"]} style={{ backgroundColor: "#fbeee4" }}>
          {lines.map((l) => <Text key={l.key} style={{ color: colors.primaryDark, paddingHorizontal: 16, paddingVertical: 6, fontWeight: l.strong ? "700" : "400" }}>{l.text}</Text>)}
          {status?.update_available && !hideUpdate && (
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 6, gap: 12 }}>
              <Text style={{ color: colors.primaryDark, flex: 1 }}>A new version is available.</Text>
              {status.store_url && <Pressable onPress={() => Linking.openURL(status.store_url!)}><Text style={{ color: colors.primary, fontWeight: "700" }}>Update</Text></Pressable>}
              <Pressable onPress={() => setHideUpdate(true)}><Text style={{ color: colors.muted }}>Later</Text></Pressable>
            </View>
          )}
        </SafeAreaView>
      )}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}
