import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Field, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { Scanner, type ScanStatus } from "../../components/scanner";
import { NEXT_TEXT, hubScan } from "../../lib/hub";

type Mode = "in" | "bag" | "handover" | "receive";
const TITLE: Record<Mode, string> = { in: "Receive parcels", bag: "Sort into bags", handover: "Hand to rider", receive: "Receive stock" };
interface Bag { id: string; code: string; to: string; dest_hub_id: string; items: number; status: string }

/** One screen for every "scan many things" job. Each scan is queued (works offline) and the result shows straight away. */
export default function HubScan() {
  const router = useRouter();
  const { mode: m, hub } = useLocalSearchParams<{ mode: Mode; hub: string }>();
  const mode = (m || "in") as Mode;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [log, setLog] = useState<ScanStatus[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // mode-specific choices
  const [bags, setBags] = useState<Bag[]>([]);
  const [hubs, setHubs] = useState<{ id: string; code: string; name: string }[]>([]);
  const [bag, setBag] = useState<Bag | null>(null);
  const [riders, setRiders] = useState<{ rider_id: string; name: string; phone: string; parcels: string[] }[]>([]);
  const [rider, setRider] = useState<string | null>(null);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendor, setVendor] = useState<string | null>(null);
  const [shelf, setShelf] = useState("");
  const [qty, setQty] = useState("1");

  async function load() {
    if (mode === "bag") {
      const [{ data: b }, { data: h }] = await Promise.all([supabase().rpc("hub_board", { p_hub: hub }), supabase().from("hubs").select("id, code, name").eq("is_active", true).neq("id", hub).order("name")]);
      setBags((b?.bags ?? []) as Bag[]); setHubs(h ?? []);
    }
    if (mode === "handover") setRiders(((await supabase().rpc("hub_handover_riders", { p_hub: hub })).data ?? []) as typeof riders);
    if (mode === "receive") setVendors(((await supabase().rpc("hub_vendors", { p_hub: hub })).data ?? []) as typeof vendors);
  }
  useEffect(() => { load(); }, [mode, hub]); // eslint-disable-line react-hooks/exhaustive-deps

  async function newBag(dest: string) {
    const { data, error } = await supabase().rpc("open_bag", { p_hub: hub, p_dest_hub: dest });
    if (error) return setMsg(error.message);
    await load(); setBag({ ...(data as Bag), to: hubs.find((h) => h.id === dest)?.code ?? "", items: 0 });
  }
  async function seal() {
    if (!bag) return;
    const { error } = await supabase().rpc("seal_bag", { p_bag: bag.id, p_seal: null });
    setMsg(error ? error.message : `${bag.code} sealed. Print its tag at the hub desk.`); setBag(null); load();
  }

  async function onScan(code: string) {
    const action: Record<string, unknown> = { type: mode, hub_id: hub, code };
    if (mode === "bag") action.bag_id = bag!.id;
    if (mode === "handover") action.rider_id = rider;
    if (mode === "receive") Object.assign(action, { vendor_id: vendor, qty: Number(qty) || 1, location: shelf });
    let s: ScanStatus;
    try {
      const r = await hubScan(action);
      if (r === null) s = { ok: true, text: `${code}: saved (no signal) — will send` };
      else if (!r.ok) s = { ok: false, text: String(r.error ?? "Refused") };
      else if (mode === "in") s = { ok: true, text: `${code} ✓ ${String(r.status ?? "").replaceAll("_", " ").toLowerCase()} ${NEXT_TEXT[String(r.next)] ?? ""}${r.dest ? ` (${r.dest})` : ""}` };
      else if (mode === "bag") s = { ok: true, text: `${code} ✓ in ${r.bag} (${r.in_bag})` };
      else if (mode === "handover") s = { ok: true, text: `${code} ✓ with ${r.rider}` };
      else s = { ok: true, text: `${r.name}: +${r.received} on ${r.location} (${r.on_hand} in stock)` };
    } catch (e) { s = { ok: false, text: (e as Error).message }; }
    setStatus(s); setLog((l) => [s, ...l].slice(0, 50));
  }

  const ready = mode === "in" || (mode === "bag" && !!bag) || (mode === "handover" && !!rider) || (mode === "receive" && !!vendor);
  return (
    <Screen>
      <Title sub={mode === "handover" ? "Choose the rider, then scan their parcels" : mode === "bag" ? "Choose or open a bag, then scan parcels into it" : mode === "receive" ? "Choose the vendor and shelf, then scan products" : "Scan each parcel as it comes in"}>{TITLE[mode]}</Title>
      <Banner text={msg} kind="info" />

      {mode === "bag" && <>
        <Text style={{ fontWeight: "700", marginBottom: 6 }}>Open bags</Text>
        {bags.filter((b) => b.status === "open").map((b) => <Pressable key={b.id} onPress={() => setBag(b)} style={{ padding: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: bag?.id === b.id ? colors.primary : "#e6e1da", backgroundColor: bag?.id === b.id ? "#fbeee4" : "#fff" }}>
          <Text style={{ fontWeight: "800" }}>To {b.to.replace("-HUB", "")} · {b.items} parcel(s)</Text><Text style={{ color: colors.muted }}>{b.code}</Text></Pressable>)}
        <Text style={{ color: colors.muted, marginVertical: 6 }}>New bag to:</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{hubs.map((h) => <Pressable key={h.id} onPress={() => newBag(h.id)} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: "#e6e1da", backgroundColor: "#fff" }}><Text>+ {h.name}</Text></Pressable>)}</View>
        {bag && <Button title={`Seal ${bag.code}`} kind="secondary" onPress={seal} />}
      </>}

      {mode === "handover" && <>
        {riders.map((r) => <Pressable key={r.rider_id} onPress={() => setRider(r.rider_id)} style={{ padding: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: rider === r.rider_id ? colors.primary : "#e6e1da", backgroundColor: rider === r.rider_id ? "#fbeee4" : "#fff" }}>
          <Text style={{ fontWeight: "800" }}>{r.name} · {r.phone}</Text><Text style={{ color: colors.muted }}>{(r.parcels ?? []).join(", ")}</Text></Pressable>)}
        {!riders.length && <Text style={{ color: colors.muted }}>No rider is coming for parcels yet. Dispatch plans delivery trips from the dashboard.</Text>}
      </>}

      {mode === "receive" && <>
        {vendors.map((v) => <Pressable key={v.id} onPress={() => setVendor(v.id)} style={{ padding: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: vendor === v.id ? colors.primary : "#e6e1da", backgroundColor: vendor === v.id ? "#fbeee4" : "#fff" }}>
          <Text style={{ fontWeight: "800" }}>{v.name}</Text></Pressable>)}
        <Field label="Shelf / bin" value={shelf} onChangeText={(t) => setShelf(t.toUpperCase())} placeholder="e.g. A-03-2 (empty = RECEIVING)" />
        <Field label="Quantity per scan" keyboardType="number-pad" value={qty} onChangeText={setQty} />
      </>}

      <Button title={ready ? "Start scanning" : mode === "bag" ? "Choose a bag first" : mode === "handover" ? "Choose a rider first" : "Choose a vendor first"} disabled={!ready} onPress={() => { setStatus(null); setOpen(true); }} />
      {log.map((l, i) => <Text key={i} style={{ color: l.ok ? colors.text : colors.danger, paddingVertical: 3 }}>{l.ok ? "✓" : "✗"} {l.text}</Text>)}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
      <Scanner visible={open} continuous title={TITLE[mode]} status={status} onScan={onScan} onClose={() => { setOpen(false); load(); }} />
    </Screen>
  );
}
