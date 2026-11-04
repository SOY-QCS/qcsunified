import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors } from "@qcs/ui";
import { AuthProvider, placeFor, useAuth } from "../lib/auth";

function Gate() {
  const { ready, session, account } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (!session) { if (segments[0] !== "(auth)") router.replace("/login"); return; }
    if (!account) return;
    const target = `/${placeFor(account)}` as const;
    if (segments[segments.length - 1] !== target.slice(1)) router.replace(target);
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
