import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import type { Offer } from "../lib/job";

const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;

/** A job offer with a 20-second countdown. */
export function OfferCard({ offer, onAnswer, busy }: { offer: Offer; onAnswer: (accept: boolean) => void; busy: boolean }) {
  const left = () => Math.max(0, Math.ceil((new Date(offer.expires_at).getTime() - Date.now()) / 1000));
  const [secs, setSecs] = useState(left());
  useEffect(() => { const t = setInterval(() => setSecs(left()), 250); return () => clearInterval(t); });
  return (
    <View style={{ backgroundColor: "#fff", borderRadius: 16, padding: 18, borderWidth: 2, borderColor: colors.primary, marginVertical: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>{offer.trip_type === "express" ? "Express job" : `Trip · ${offer.stops} drop-offs`}</Text>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: secs <= 5 ? colors.danger : colors.primary, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "900" }}>{secs}</Text>
        </View>
      </View>
      <Text style={{ marginTop: 10, color: colors.muted }}>Pickup · {(offer.distance_m / 1000).toFixed(1)} km away</Text>
      <Text style={{ fontWeight: "700" }}>{offer.pickup}</Text>
      <Text style={{ marginTop: 6, color: colors.muted }}>Drop-off</Text>
      <Text style={{ fontWeight: "700" }}>{offer.dropoff}</Text>
      <Text style={{ marginTop: 6 }}>Delivery fees: {ghs(offer.fee)}{offer.cod_total ? ` · Cash to collect: ${ghs(offer.cod_total)}` : ""}</Text>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <View style={{ flex: 1 }}><Button title="Reject" kind="danger" onPress={() => onAnswer(false)} disabled={busy || secs === 0} /></View>
        <View style={{ flex: 2 }}><Button title="Accept" onPress={() => onAnswer(true)} busy={busy} disabled={secs === 0} /></View>
      </View>
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>Rejected or missed offers lower your score.</Text>
    </View>
  );
}
