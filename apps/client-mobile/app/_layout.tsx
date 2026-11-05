import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@qcs/ui";
import { AppGate } from "@qcs/mobile";
import { AuthProvider, needsOnboarding, useAuth } from "../lib/auth";

function Gate() {
  const { ready, session, account } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const group = segments[0];
    if (!session) { if (group !== "(auth)") router.replace("/login"); return; }
    if (!account) return; // still loading the account
    if (needsOnboarding(account)) { if (group !== "(onboarding)") router.replace("/choose"); return; }
    if (group !== "(app)") router.replace("/home");
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
        <AppGate app="client">
          <Gate />
        </AppGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
