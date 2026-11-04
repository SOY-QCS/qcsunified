import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Screen, Title } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { isOpenStop, navigationUrl, suggestedRoute } from "@qcs/types";
import { useJob, type JobOrder } from "../../lib/job";
import { here, startTracking } from "../../lib/location";
import { act } from "../../lib/queue";
import { Scanner } from "../../components/scanner";

const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;

/** The current job: pickup first (confirm every parcel), then drop-offs — nearest next, but the rider can pick any. */
export default function JobScreen() {
  const router = useRouter();
  const { job, loading, refresh, setJob } = useJob();
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "info" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { startTracking(true); here().then(setPos); const t = setInterval(() => here().then(setPos), 20_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!loading && !job) router.replace("/home"); }, [loading, job, router]);

  const orders = job?.orders ?? [];
  const atPickup = orders.filter((o) => ["ASSIGNED", "RIDER_AT_PICKUP"].includes(o.status));
  const route = useMemo(() => suggestedRoute(orders.filter((o) => !["ASSIGNED", "RIDER_AT_PICKUP"].includes(o.status))
    .map((o) => ({ ...o, lat: o.dropoff_lat, lng: o.dropoff_lng })), pos), [orders, pos]);

  // Update the screen immediately; the queue sends it when there's signal.
  async function move(list: JobOrder[], to: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setMsg(null);
    const p = await here();
    try {
      for (const o of list) {
        const r = await act({ type: "status", order_id: o.id, to, lng: p?.lng, lat: p?.lat, ...extra });
        if (r === null) setMsg({ text: "No signal — saved on your phone, will send automatically.", kind: "info" });
      }
      setJob((j) => j && { ...j, orders: j.orders.map((o) => (list.some((x) => x.id === o.id) ? { ...o, status: to } : o)) });
      setTimeout(refresh, 1500);
    } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); }
    finally { setBusy(false); }
  }

  function scanned(code: string) {
    setScanning(false);
    const o = atPickup.find((x) => x.tracking_number === code);
    if (!o) return setMsg({ text: `${code} is not on this job.`, kind: "error" });
    setConfirmed((s) => new Set(s).add(o.id));
    if (o.pickup_code_required) act({ type: "pickup_code", order_id: o.id, code }).catch(() => {});
  }

  if (!job) return <Screen><Text>Loading…</Text></Screen>;
  const first = atPickup[0] ?? orders[0]!;
  const allConfirmed = atPickup.every((o) => confirmed.has(o.id));

  return (
    <Screen>
      <Title sub={`${orders.length} parcel${orders.length > 1 ? "s" : ""} · ${job.trip.trip_type}`}>Current job</Title>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />

      {atPickup.length > 0 ? (
        <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#e6e1da" }}>
          <Text style={{ fontSize: 18, fontWeight: "800" }}>1. Pickup</Text>
          <Text style={{ fontWeight: "700", marginTop: 6 }}>{first.pickup_address}</Text>
          <Text style={{ color: colors.muted }}>{first.pickup_contact} · {first.pickup_phone}{first.pickup_note ? `\n${first.pickup_note}` : ""}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Button title="Navigate" kind="secondary" onPress={() => Linking.openURL(navigationUrl({ lat: first.pickup_lat, lng: first.pickup_lng }))} /></View>
            <View style={{ flex: 1 }}><Button title="Call" kind="secondary" onPress={() => Linking.openURL(`tel:${first.pickup_phone}`)} /></View>
          </View>
          {atPickup.some((o) => o.status === "ASSIGNED")
            ? <Button title="I've arrived at pickup" onPress={() => move(atPickup.filter((o) => o.status === "ASSIGNED"), "RIDER_AT_PICKUP")} busy={busy} />
            : <>
                <Text style={{ marginTop: 12, fontWeight: "700" }}>Confirm each parcel ({confirmed.size}/{atPickup.length})</Text>
                {atPickup.map((o) => (
                  <Pressable key={o.id} onPress={() => setConfirmed((s) => { const n = new Set(s); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })}
                    style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderColor: "#f0ebe4" }}>
                    <Text>{confirmed.has(o.id) ? "✅" : "⬜"} {o.tracking_number}{o.fragile ? " · FRAGILE" : ""}</Text>
                    <Text style={{ color: colors.muted }}>{(o.weight_g / 1000).toFixed(1)} kg</Text>
                  </Pressable>
                ))}
                <Button title="Scan parcel labels" kind="secondary" onPress={() => setScanning(true)} />
                <Button title={allConfirmed ? "Picked up — start deliveries" : "Confirm every parcel first"} disabled={!allConfirmed} busy={busy}
                  onPress={async () => { await move(atPickup, "PICKED_UP"); await move(atPickup, "IN_TRANSIT"); }} />
              </>}
        </View>
      ) : (
        <>
          <Text style={{ fontSize: 18, fontWeight: "800", marginBottom: 8 }}>Drop-offs — nearest first</Text>
          {route.map((o, i) => (
            <Pressable key={o.id} onPress={() => router.push({ pathname: "/deliver", params: { id: o.id } })}
              style={{ backgroundColor: i === 0 ? "#fbeee4" : "#fff", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: i === 0 ? colors.primary : "#e6e1da" }}>
              <Text style={{ fontWeight: "800" }}>{i === 0 ? "Next: " : ""}{o.recipient_name}</Text>
              <Text style={{ color: colors.muted }}>{o.dropoff_address}{o.landmark ? ` (${o.landmark})` : ""}</Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>{o.tracking_number}{o.cod_amount ? ` · collect ${ghs(o.cod_amount)}` : ""} · {o.status.replaceAll("_", " ").toLowerCase()}</Text>
            </Pressable>
          ))}
          {orders.filter((o) => !isOpenStop(o.status)).length > 0 && (
            <Text style={{ color: colors.muted, marginTop: 8 }}>Done: {orders.filter((o) => !isOpenStop(o.status)).map((o) => `${o.tracking_number} (${o.status.toLowerCase().replaceAll("_", " ")})`).join(", ")}</Text>
          )}
          {route.length === 0 && <Button title="All stops done — back to home" onPress={() => { refresh(); router.replace("/home"); }} />}
        </>
      )}
      <Button title="Refresh" kind="secondary" onPress={refresh} />
      <Scanner visible={scanning} onScan={scanned} onClose={() => setScanning(false)} />
    </Screen>
  );
}
