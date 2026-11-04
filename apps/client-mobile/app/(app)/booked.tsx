import { useState } from "react";
import { Image, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Banner, Button, Screen, Title } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { API_URL, authHeader, ghs, type BookingResult } from "../../lib/api";

/** After booking: tracking numbers, QR codes and the label PDF to print or send on WhatsApp. */
export default function Booked() {
  const router = useRouter();
  const { data } = useLocalSearchParams<{ data: string }>();
  const r = JSON.parse(data ?? "{}") as BookingResult;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = (r.orders ?? []).map((o) => o.id).join(",");

  async function shareLabels(size: "a6" | "4x6") {
    setBusy(size); setError(null);
    try {
      const file = await File.downloadFileAsync(`${API_URL}/api/v1/labels?orders=${ids}&size=${size}`, new File(Paths.cache, `qcs-labels-${size}.pdf`),
        { headers: await authHeader(), idempotent: true });
      await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: "Print or send labels" });
    } catch (e) { setError(`Couldn't get the labels: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }

  return (
    <Screen>
      <Title sub={r.needs_payment ? "Waiting for payment — QCS will contact you to pay while online payment is being set up." : "We're finding a rider."}>Booked ✓</Title>
      {(r.orders ?? []).map((o) => (
        <View key={o.id} style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: "#e6e1da" }}>
          <Image source={{ uri: `${API_URL}/api/v1/qr/${o.tracking_number}.png` }} style={{ width: 64, height: 64, marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "800", fontSize: 17 }}>{o.tracking_number}</Text>
            <Text style={{ color: colors.muted }}>{ghs(o.fee)}</Text>
          </View>
        </View>
      ))}
      <Text style={{ fontWeight: "700", marginTop: 12 }}>Total: {ghs(r.total ?? 0)}</Text>
      <Text style={{ color: colors.muted, marginVertical: 8 }}>Stick the label on the parcel. Riders scan its QR code at pickup and delivery.</Text>
      <Banner text={error} />
      <Button title="Share label (A6)" onPress={() => shareLabels("a6")} busy={busy === "a6"} />
      <Button title="Share label (4×6 thermal)" kind="secondary" onPress={() => shareLabels("4x6")} busy={busy === "4x6"} />
      <Button title="Done" kind="secondary" onPress={() => router.replace("/home")} />
    </Screen>
  );
}
