import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { Banner, Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";

export default function Home() {
  const { session, account } = useAuth();
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase().from("riders").select("is_online").eq("id", session!.user.id).single().then(({ data }) => setOnline(!!data?.is_online));
  }, [session]);

  async function toggle(v: boolean) {
    setError(null);
    setOnline(v);
    const { error } = await supabase().from("riders").update({ is_online: v }).eq("id", session!.user.id);
    if (error) { setOnline(!v); setError(error.message); }
  }

  return (
    <Screen>
      <Title sub={account?.rider?.rider_type === "fleet" ? "QCS fleet rider" : "Independent rider"}>Hi {(account?.profile?.full_name ?? "").split(" ")[0]}</Title>
      <View style={{ backgroundColor: online ? "#eaf6ee" : "#fff", borderRadius: 14, padding: 18, borderWidth: 1, borderColor: "#e6e1da", flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: "800" }}>{online ? "You're online" : "You're offline"}</Text>
          <Text style={{ color: colors.muted }}>{online ? "Jobs near you will appear here." : "Go online to receive jobs."}</Text>
        </View>
        <Switch value={online} onValueChange={toggle} />
      </View>
      <Banner text={error} />
      <Text style={{ color: colors.muted, marginTop: 16 }}>Job offers, navigation, scanning and earnings arrive in the next update.</Text>
      <View style={{ flex: 1 }} />
      <Button title="Sign out" kind="secondary" onPress={async () => { await toggle(false); await supabase().auth.signOut(); }} />
    </Screen>
  );
}
