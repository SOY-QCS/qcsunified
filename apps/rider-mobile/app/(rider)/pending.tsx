import { Text } from "react-native";
import { Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";

export default function Pending() {
  const { refresh } = useAuth();
  return (
    <Screen>
      <Title sub="Thanks for applying. A QCS admin is checking your documents.">Application received</Title>
      <Text style={{ color: colors.muted, marginBottom: 16 }}>We'll send you an SMS when you're approved — usually within 1–2 working days. If something needs fixing, you'll see the reason here.</Text>
      <Button title="Check again" kind="secondary" onPress={refresh} />
      <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />
    </Screen>
  );
}
