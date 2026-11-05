import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@qcs/ui";
import { AuthProvider, placeFor, useAuth } from "../lib/auth";
import "../lib/location";   // registers the background location task at start-up
import "../lib/queue";      // starts the offline queue retry loop

function Gate() {
  const { ready, session, account } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (!session) { if (segments[0] !== "(auth)") router.replace("/login"); return; }
    if (!account) return;
    const place = placeFor(account);
    const here = segments[segments.length - 1];
    // active riders may move between home, job and deliver; everyone else stays on their one screen
    const allowed = place === "home" ? ["home", "job", "deliver", "earnings", "support"]
      : place === "hub" ? ["hub", "hub-scan", "hub-manifest", "hub-collect", "hub-pick", "support"] : [place];
    if (!allowed.includes(here as string)) router.replace(`/${place}`);
  }, [ready, session, account, segments, router]);

  if (!ready) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}><ActivityIndicator color={colors.primary} /></View>;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
