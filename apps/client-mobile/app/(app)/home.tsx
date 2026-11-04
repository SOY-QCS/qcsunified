import { useState } from "react";
import { Text, View } from "react-native";
import { Banner, Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";

const KYC_TEXT: Record<string, { text: string; kind: "info" | "success" | "error" }> = {
  pending: { text: "We're checking your business ID. You can book deliveries meanwhile.", kind: "info" },
  approved: { text: "Business verified ✓", kind: "success" },
  rejected: { text: "We couldn't verify your ID. Please contact QCS support.", kind: "error" },
};

export default function Home() {
  const { account } = useAuth();
  const vendor = account?.vendor;
  const [mode, setMode] = useState<"business" | "personal">(vendor ? "business" : "personal");
  const first = (account?.profile?.full_name ?? "").split(" ")[0];

  return (
    <Screen>
      <Title sub={mode === "business" && vendor ? vendor.business_name : "Personal account"}>Akwaaba{first ? `, ${first}` : ""}</Title>
      {vendor && (
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          <View style={{ flex: 1 }}><Button title="Business" kind={mode === "business" ? "primary" : "secondary"} onPress={() => setMode("business")} /></View>
          <View style={{ flex: 1 }}><Button title="Personal" kind={mode === "personal" ? "primary" : "secondary"} onPress={() => setMode("personal")} /></View>
        </View>
      )}
      {vendor && mode === "business" && KYC_TEXT[vendor.kyc_status] && <Banner text={KYC_TEXT[vendor.kyc_status]!.text} kind={KYC_TEXT[vendor.kyc_status]!.kind} />}
      <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 18, marginVertical: 12, borderWidth: 1, borderColor: "#e6e1da" }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Book a delivery</Text>
        <Text style={{ color: colors.muted, marginTop: 6 }}>Booking, tracking and your wallet arrive in the next update.</Text>
      </View>
      <View style={{ flex: 1 }} />
      <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />
    </Screen>
  );
}
