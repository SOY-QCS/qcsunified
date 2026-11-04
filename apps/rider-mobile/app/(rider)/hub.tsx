import { Text } from "react-native";
import { Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";

/** Hub mode: only hub handlers see this. Scanning arrives with the hubs phase. */
export default function Hub() {
  const { account } = useAuth();
  const hub = account?.roles.find((r) => r.role === "hub_handler");
  return (
    <Screen>
      <Title sub={hub?.hub_code ? `Hub: ${hub.hub_code}` : `All hubs in ${hub?.city_code ?? "your city"}`}>Hub mode</Title>
      <Text style={{ color: colors.muted, marginBottom: 16 }}>Scan in, scan out, sort to route and hand over to riders — coming in the hubs update.</Text>
      <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />
    </Screen>
  );
}
