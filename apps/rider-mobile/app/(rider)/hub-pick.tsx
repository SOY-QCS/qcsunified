import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Field, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { Scanner, type ScanStatus } from "../../components/scanner";
import { hubScan } from "../../lib/hub";

interface Item { sku: string; name: string; barcode: string | null; qty: number; picked: number; locations: Record<string, number> | null }
interface Pick { order_id: string; tracking_number: string; vendor: string; service: string; recipient: string; items: Item[] }

/** Fulfilment: pick each product by scanning its barcode (it comes off the shelf), then pack. */
export default function HubPick() {
  const router = useRouter();
  const { hub } = useLocalSearchParams<{ hub: string }>();
  const [list, setList] = useState<Pick[]>([]);
  const [cur, setCur] = useState<Pick | null>(null);
  const [scan, setScan] = useState(false);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [kg, setKg] = useState("");
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);

  async function load() {
    const { data } = await supabase().rpc("pick_list", { p_hub: hub });
    const l = (data ?? []) as Pick[];
    setList(l); setCur((c) => (c ? l.find((x) => x.order_id === c.order_id) ?? null : null));
  }
  useEffect(() => { load(); }, [hub]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onScan(code: string) {
    const r = await hubScan({ type: "pick", hub_id: hub, order_id: cur!.order_id, code }).catch((e) => ({ ok: false, error: (e as Error).message } as Record<string, unknown>));
    setStatus(r === null ? { ok: true, text: `${code}: saved (no signal)` } : r.ok ? { ok: true, text: `${r.name} ✓ from ${r.from} — ${r.left_to_pick} left` } : { ok: false, text: String(r.error) });
  }
  async function pack() {
    const { data, error } = await supabase().rpc("pack_order", { p_order: cur!.order_id, p_weight_g: kg ? Math.round(Number(kg) * 1000) : null });
    if (error) return setMsg({ text: error.message, kind: "error" });
    setMsg({ text: data.next === "print_label" ? `${cur!.tracking_number} packed — print its label at the hub desk (inter-city).` : `${cur!.tracking_number} packed — ready for a rider.`, kind: "success" });
    setCur(null); setKg(""); load();
  }

  const left = cur ? cur.items.reduce((n, i) => n + i.qty - i.picked, 0) : 0;
  return (
    <Screen>
      <Title sub={`${list.length} order(s) to prepare`}>Pick & pack</Title>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />
      {!cur && list.map((p) => <Pressable key={p.order_id} onPress={() => setCur(p)} style={{ padding: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: "#e6e1da", backgroundColor: "#fff" }}>
        <Text style={{ fontWeight: "800" }}>{p.tracking_number} · {p.vendor}</Text>
        <Text style={{ color: colors.muted }}>{p.items.map((i) => `${i.qty}× ${i.name}`).join(", ")} · {p.service}</Text></Pressable>)}
      {cur && <>
        <Text style={{ fontSize: 18, fontWeight: "800" }}>{cur.tracking_number}</Text>
        <Text style={{ color: colors.muted }}>{cur.vendor} → {cur.recipient}</Text>
        {cur.items.map((i) => (
          <View key={i.sku} style={{ paddingVertical: 8, borderBottomWidth: 1, borderColor: "#f0ebe4" }}>
            <Text style={{ fontWeight: "700" }}>{i.picked >= i.qty ? "✅" : "⬜"} {i.qty}× {i.name} <Text style={{ color: colors.muted }}>({i.sku})</Text></Text>
            <Text style={{ color: colors.muted }}>Picked {i.picked}/{i.qty} · shelves: {Object.entries(i.locations ?? {}).map(([l, n]) => `${l} (${n})`).join(", ") || "none!"}</Text>
          </View>
        ))}
        {left > 0 ? <Button title={`Scan products (${left} to go)`} onPress={() => { setStatus(null); setScan(true); }} /> : <>
          <Field label="Packed weight (kg, optional)" keyboardType="decimal-pad" value={kg} onChangeText={setKg} />
          <Button title="Packed" onPress={pack} />
        </>}
        <Button title="Other orders" kind="secondary" onPress={() => setCur(null)} />
      </>}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
      <Scanner visible={scan} continuous title={`Pick ${cur?.tracking_number ?? ""}`} status={status} onScan={onScan} onClose={() => { setScan(false); load(); }} />
    </Screen>
  );
}
