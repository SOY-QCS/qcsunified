import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen, Title } from "@qcs/mobile";
import { colors, radius, spacing } from "@qcs/ui";

function Option({ title, body, onPress }: { title: string; body: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button"
      style={({ pressed }) => ({ backgroundColor: "#fff", borderRadius: radius.lg, borderWidth: 1, borderColor: pressed ? colors.primary : "#e6e1da", padding: spacing.lg, marginBottom: spacing.md })}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }}>{title}</Text>
      <Text style={{ color: colors.muted, marginTop: 6 }}>{body}</Text>
    </Pressable>
  );
}

export default function Choose() {
  const router = useRouter();
  return (
    <Screen>
      <Title sub="You can add a business account later too.">How will you use QCS?</Title>
      <View>
        <Option title="Personal" body="Send parcels to friends, family and customers now and then." onPress={() => router.push("/individual")} />
        <Option title="Business / online vendor" body="Regular deliveries, bulk trips of up to 25 orders, Cash on Delivery, wallet and statements." onPress={() => router.push("/vendor")} />
      </View>
    </Screen>
  );
}
