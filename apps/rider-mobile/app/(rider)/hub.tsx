import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import type { Queue } from "@qcs/types";
import { useHub } from "../../lib/hub";
import { onQueue } from "../../lib/queue";

const TILES: { href: string; mode?: string; title: string; hint: string; count?: string }[] = [
  { href: "/hub-scan", mode: "in", title: "Receive parcels", hint: "From riders, vendors, or off the bus", count: "coming_in" },
  { href: "/hub-scan", mode: "bag", title: "Sort into bags", hint: "One bag per destination hub", count: "to_sort" },
  { href: "/hub-manifest", mode: "out", title: "Load the bus", hint: "Scan bags onto a manifest, add bus details" },
  { href: "/hub-manifest", mode: "in", title: "Bus arrivals", hint: "Receive a manifest, scan bags in", count: "on_the_road_to_here" },
  { href: "/hub-scan", mode: "handover", title: "Hand to rider", hint: "Parcels going out for delivery", count: "for_last_mile" },
  { href: "/hub-collect", title: "Collection", hint: "Recipient collects with their code", count: "for_collection" },
  { href: "/hub-scan", mode: "receive", title: "Receive stock", hint: "Fulfilment: vendor products onto shelves" },
  { href: "/hub-pick", title: "Pick & pack", hint: "Fulfilment orders to prepare" },
];

/** Hub mode (hub handlers only): everything is scanning with the phone camera; works offline and catches up later. */
export default function HubHome() {
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const { hubs, hub, setHub } = useHub();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState<Queue | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => onQueue(setQ), []);
  const load = useCallback(async () => {
    if (!hub) return;
    setBusy(true);
    const { data } = await supabase().rpc("hub_board", { p_hub: hub.id });
    setCounts((data?.counts ?? {}) as Record<string, number>);
    setBusy(false);
  }, [hub]);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, paddingTop: inset.top + 16 }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Title sub={hub ? `${hub.name} · ${counts.in_hub ?? 0} parcels in the hub` : "No hub linked to your account — ask your Hub Manager"}>Hub mode</Title>
      {hubs.length > 1 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {hubs.map((h) => <Pressable key={h.id} onPress={() => setHub(h)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: h.id === hub?.id ? colors.primary : "#e6e1da", backgroundColor: h.id === hub?.id ? "#fbeee4" : "#fff" }}>
          <Text>{h.name}</Text></Pressable>)}
      </View>}
      {q && q.items.length > 0 && <Text style={{ color: colors.warning, marginBottom: 8 }}>{q.items.length} scan(s) saved on the phone — they send when there's signal.</Text>}
      {q && q.failed.length > 0 && <Text style={{ color: colors.danger, marginBottom: 8 }}>{q.failed.length} scan(s) were refused — check them with your manager.</Text>}
      {hub && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {TILES.map((t) => (
          <Pressable key={t.title} onPress={() => router.push({ pathname: t.href as "/hub-scan", params: { mode: t.mode ?? "", hub: hub.id } })}
            style={{ width: "48%", backgroundColor: "#fff", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#e6e1da", minHeight: 100 }}>
            <Text style={{ fontWeight: "800", fontSize: 16 }}>{t.title}</Text>
            <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>{t.hint}</Text>
            {t.count && counts[t.count] ? <Text style={{ color: colors.primary, fontWeight: "900", fontSize: 20, marginTop: 6 }}>{counts[t.count]}</Text> : null}
          </Pressable>
        ))}
      </View>}
      {(counts.labels_to_print ?? 0) > 0 && <Text style={{ marginTop: 12, color: colors.muted }}>{counts.labels_to_print} parcel(s) need a label — print them at the hub desk (Ops dashboard → Hubs → your hub).</Text>}
      <View style={{ height: 24 }} />
      <Button title="Help & support" kind="secondary" onPress={() => router.push("/support")} />
      <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />
    </ScrollView>
  );
}
