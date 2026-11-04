import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { STATUS_LABELS, isLive, type OrderStatus } from "@qcs/types";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Row { id: string; tracking_number: string; status: OrderStatus; recipient_name: string; dropoff_address_text: string | null; created_at: string }

/** My deliveries: moving ones first, then the most recent. */
export default function Orders() {
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const { data } = await supabase().from("orders").select("id, tracking_number, status, recipient_name, dropoff_address_text, created_at")
      .not("status", "eq", "DRAFT").order("created_at", { ascending: false }).limit(50);
    setRows(((data ?? []) as Row[]).sort((a, b) => Number(isLive(b.status)) - Number(isLive(a.status))));
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, paddingTop: inset.top + 16 }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Title>My deliveries</Title>
      {rows.map((o) => (
        <Pressable key={o.id} onPress={() => router.push({ pathname: "/track", params: { tn: o.tracking_number } })}
          style={{ backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: isLive(o.status) ? colors.primary : "#e6e1da" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontWeight: "800" }}>{o.recipient_name}</Text>
            <Text style={{ color: isLive(o.status) ? colors.primary : colors.muted, fontWeight: "700" }}>{STATUS_LABELS[o.status]}</Text>
          </View>
          <Text style={{ color: colors.muted }} numberOfLines={1}>{o.dropoff_address_text}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{o.tracking_number}</Text>
        </Pressable>
      ))}
      {!busy && rows.length === 0 && <Text style={{ color: colors.muted }}>No deliveries yet.</Text>}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}
