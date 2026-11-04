import { useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import MapView, { Marker } from "react-native-maps";
import { Banner, Button, Screen, Title } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { RIDER_RATING_TAGS, STATUS_LABELS, etaText, isLive, whatsappLink } from "@qcs/types";
import { api } from "../../lib/api";
import { useTracking } from "../../lib/tracking";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Live tracking: map with the rider, arrival estimate, rider card with call/WhatsApp, history, and rating after delivery. */
export default function Track() {
  const router = useRouter();
  const { tn } = useLocalSearchParams<{ tn: string }>();
  const { data: r, error, refresh } = useTracking(tn);
  const map = useRef<MapView>(null);
  const fitted = useRef(false);

  const live = r?.status ? isLive(r.status) : false;
  const points = [
    r?.rider?.location && { key: "rider", ...r.rider.location, title: r.rider.first_name, color: colors.primary },
    r?.dropoff && { key: "drop", lat: r.dropoff.lat, lng: r.dropoff.lng, title: "Drop-off", color: colors.success },
    r?.pickup && r.status && ["ASSIGNED", "RIDER_AT_PICKUP"].includes(r.status) && { key: "pick", lat: r.pickup.lat, lng: r.pickup.lng, title: "Pickup", color: "#333" },
  ].filter(Boolean) as { key: string; lat: number; lng: number; title: string; color: string }[];

  useEffect(() => {
    if (fitted.current || points.length < 2 || !map.current) return;
    map.current.fitToCoordinates(points.map((p) => ({ latitude: p.lat, longitude: p.lng })), { edgePadding: { top: 60, bottom: 60, left: 60, right: 60 }, animated: false });
    fitted.current = true;
  });

  if (!r) return <Screen><Banner text={error} /><Text>Loading…</Text></Screen>;
  const eta = etaText(r.eta_minutes);
  return (
    <Screen>
      <Title sub={r.tracking_number}>{r.status ? STATUS_LABELS[r.status] : ""}</Title>
      {live && eta && <Text style={{ fontSize: 18, fontWeight: "800", color: colors.primary, marginBottom: 8 }}>
        {r.status === "ARRIVED_AT_DROPOFF" ? "The rider is at the door" : `Arrives ${eta}`}</Text>}
      <Banner text={error} />

      {live && points.length > 0 && (
        <MapView ref={map} style={{ height: 280, borderRadius: 14, marginBottom: 12 }}
          initialRegion={{ latitude: points[0]!.lat, longitude: points[0]!.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }}>
          {points.map((p) => <Marker key={p.key} coordinate={{ latitude: p.lat, longitude: p.lng }} title={p.title} pinColor={p.color} />)}
        </MapView>
      )}

      {r.dropoff?.address && <Text style={{ color: colors.muted, marginBottom: 8 }}>To {r.recipient_name} · {r.dropoff.address}</Text>}

      {r.rider && (
        <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#e6e1da", flexDirection: "row", alignItems: "center", gap: 12 }}>
          {r.rider.photo_url
            ? <Image source={{ uri: r.rider.photo_url }} style={{ width: 56, height: 56, borderRadius: 28 }} />
            : <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#fff", fontSize: 22, fontWeight: "800" }}>{r.rider.first_name.slice(0, 1)}</Text></View>}
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "800", fontSize: 16 }}>{r.rider.first_name} · ★ {Number(r.rider.rating).toFixed(1)}</Text>
            <Text style={{ color: colors.muted }}>{[r.rider.make_model ?? r.rider.vehicle, r.rider.plate].filter(Boolean).join(" · ")}</Text>
          </View>
        </View>
      )}
      {r.rider?.phone && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}><Button title="Call rider" onPress={() => Linking.openURL(`tel:${r.rider!.phone}`)} /></View>
          <View style={{ flex: 1 }}><Button title="WhatsApp" kind="secondary" onPress={() => Linking.openURL(whatsappLink(r.rider!.phone!, `Hello, I'm checking on QCS parcel ${r.tracking_number}`))} /></View>
        </View>
      )}

      {r.can_rate && <RateRider tn={r.tracking_number!} name={r.rider?.first_name ?? "your rider"} onDone={refresh} />}

      <Text style={{ fontWeight: "800", fontSize: 16, marginTop: 16, marginBottom: 6 }}>History</Text>
      {[...(r.timeline ?? [])].reverse().map((e, i) => (
        <View key={i} style={{ flexDirection: "row", paddingVertical: 6, borderTopWidth: i ? 1 : 0, borderColor: "#f0ebe4" }}>
          <Text style={{ flex: 1, fontWeight: i === 0 ? "800" : "400" }}>{STATUS_LABELS[e.status] ?? e.status}</Text>
          <Text style={{ color: colors.muted }}>{when(e.at)}</Text>
        </View>
      ))}
      <Button title="Back" kind="secondary" onPress={() => (router.canGoBack() ? router.back() : router.replace("/orders"))} />
    </Screen>
  );
}

function RateRider({ tn, name, onDone }: { tn: string; name: string; onDone: () => void }) {
  const [score, setScore] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const options = score >= 4 ? RIDER_RATING_TAGS.good : score ? RIDER_RATING_TAGS.bad : [];
  async function send() {
    setBusy(true); setMsg(null);
    try { await api("/api/v1/ratings", { method: "POST", body: JSON.stringify({ tracking_number: tn, score, tags, comment: comment || undefined }) }); onDone(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, marginTop: 12, borderWidth: 2, borderColor: colors.primary }}>
      <Text style={{ fontWeight: "800", fontSize: 16 }}>How was {name}?</Text>
      <View style={{ flexDirection: "row", marginVertical: 8 }}>
        {[1, 2, 3, 4, 5].map((n) => <Pressable key={n} onPress={() => { setScore(n); setTags([]); }} accessibilityLabel={`${n} stars`} style={{ padding: 4 }}>
          <Text style={{ fontSize: 36, color: n <= score ? colors.primary : "#ccc" }}>★</Text></Pressable>)}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.map((t) => <Pressable key={t} onPress={() => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}
          style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1, borderColor: "#e6e1da", backgroundColor: tags.includes(t) ? "#fbeee4" : "#fff" }}>
          <Text>{t}</Text></Pressable>)}
      </View>
      {score > 0 && <>
        <TextInput placeholder="Anything else? (optional)" value={comment} onChangeText={setComment} multiline
          style={{ borderWidth: 1, borderColor: "#e6e1da", borderRadius: 10, padding: 10, marginTop: 8, minHeight: 60, backgroundColor: "#fff" }} />
        <Button title="Send rating" onPress={send} busy={busy} />
      </>}
      <Banner text={msg} />
    </View>
  );
}
