import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Banner, Button, Field, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { Scanner, type ScanStatus } from "../../components/scanner";
import { hubScan } from "../../lib/hub";

interface Manifest { id: string; code: string; status: string; from: string; to: string; bags: number; sent: number; received: number; bus: string | null; vehicle: string | null; late: boolean }

/** Line-haul. "out": create a manifest, scan bags onto it, enter the bus details, send. "in": receive a bus, scan bags in, close. */
export default function HubManifest() {
  const router = useRouter();
  const { mode, hub } = useLocalSearchParams<{ mode: "out" | "in"; hub: string }>();
  const [list, setList] = useState<Manifest[]>([]);
  const [hubs, setHubs] = useState<{ id: string; code: string; name: string }[]>([]);
  const [hubCode, setHubCode] = useState("");
  const [cur, setCur] = useState<Manifest | null>(null);
  const [bus, setBus] = useState({ bus_company: "", bus_station: "", driver_name: "", driver_phone: "", vehicle_reg: "", waybill_no: "", seal_no: "" });
  const [note, setNote] = useState("");
  const [scan, setScan] = useState(false);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [{ data: b }, { data: h }] = await Promise.all([supabase().rpc("hub_board", { p_hub: hub }), supabase().from("hubs").select("id, code, name").eq("is_active", true).order("name")]);
    setHubCode(h?.find((x) => x.id === hub)?.code ?? "");
    setHubs((h ?? []).filter((x) => x.id !== hub));
    const all = (b?.manifests ?? []) as Manifest[];
    setList(all);
    setCur((c) => (c ? all.find((x) => x.id === c.id) ?? null : null));
  }
  useEffect(() => { load(); }, [hub]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = list.filter((x) => (mode === "out" ? x.from === hubCode && x.status === "loading" : x.to === hubCode && ["departed", "arrived"].includes(x.status)));
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); } finally { setBusy(false); load(); } };
  const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase().rpc(fn, args); if (error) throw new Error(error.message); return data; };

  async function onScan(code: string) {
    try {
      if (mode === "out") { const r = await rpc("add_bag_to_manifest", { p_manifest: cur!.id, p_bag_code: code }); setStatus({ ok: true, text: `${code} ✓ loaded (${r.bags} bags, ${r.parcels} parcels)` }); }
      else {
        // a bag tag receives the whole bag; a parcel label receives one parcel
        const r = await hubScan({ type: code.startsWith("BAG-") ? "arrive_bag" : "in", hub_id: hub, code });
        setStatus(r === null ? { ok: true, text: `${code}: saved (no signal)` } : r.ok ? { ok: true, text: `${code} ✓ ${r.arrived != null ? `${r.arrived} parcels in` : String(r.status).toLowerCase().replaceAll("_", " ")}` } : { ok: false, text: String(r.error) });
      }
    } catch (e) { setStatus({ ok: false, text: (e as Error).message }); }
  }

  return (
    <Screen>
      <Title sub={mode === "out" ? "Bags onto the bus, with the bus details" : "Buses coming to this hub"}>{mode === "out" ? "Load the bus" : "Bus arrivals"}</Title>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />
      {mine.map((x) => <Pressable key={x.id} onPress={() => setCur(x)} style={{ padding: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: cur?.id === x.id ? colors.primary : x.late ? colors.danger : "#e6e1da", backgroundColor: cur?.id === x.id ? "#fbeee4" : "#fff" }}>
        <Text style={{ fontWeight: "800" }}>{x.code}</Text>
        <Text style={{ color: colors.muted }}>{x.from.replace("-HUB", "")} → {x.to.replace("-HUB", "")} · {x.bags} bag(s) · {x.status}{x.bus ? ` · ${x.bus} ${x.vehicle}` : ""}{mode === "in" ? ` · ${x.received}/${x.sent} received` : ""}{x.late ? " · LATE" : ""}</Text></Pressable>)}
      {!mine.length && <Text style={{ color: colors.muted, marginBottom: 8 }}>{mode === "out" ? "No manifest loading. Start one:" : "No bus on the way."}</Text>}
      {mode === "out" && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {hubs.map((h) => <Pressable key={h.id} disabled={busy} onPress={() => run(async () => { const m = await rpc("create_manifest", { p_hub: hub, p_dest_hub: h.id }); setCur({ ...m, from: hubCode, to: h.code, bags: 0, sent: 0, received: 0, bus: null, vehicle: null, late: false }); })}
          style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: "#e6e1da", backgroundColor: "#fff" }}><Text>+ Bus to {h.name}</Text></Pressable>)}
      </View>}

      {cur && mode === "out" && <>
        <Button title="Scan bag tags onto this manifest" onPress={() => { setStatus(null); setScan(true); }} />
        <Text style={{ fontWeight: "800", marginTop: 12 }}>Bus details (required to send)</Text>
        <Field label="Bus company" value={bus.bus_company} onChangeText={(t) => setBus({ ...bus, bus_company: t })} placeholder="VIP, STC, mini bus…" />
        <Field label="Station" value={bus.bus_station} onChangeText={(t) => setBus({ ...bus, bus_station: t })} placeholder="e.g. Kaneshie" />
        <Field label="Vehicle registration" value={bus.vehicle_reg} autoCapitalize="characters" onChangeText={(t) => setBus({ ...bus, vehicle_reg: t })} />
        <Field label="Driver name" value={bus.driver_name} onChangeText={(t) => setBus({ ...bus, driver_name: t })} />
        <Field label="Driver phone" keyboardType="phone-pad" value={bus.driver_phone} onChangeText={(t) => setBus({ ...bus, driver_phone: t })} />
        <Field label="Bus waybill number" value={bus.waybill_no} onChangeText={(t) => setBus({ ...bus, waybill_no: t })} />
        <Field label="Seal number" value={bus.seal_no} onChangeText={(t) => setBus({ ...bus, seal_no: t })} />
        <Button title="Bus has left — send manifest" busy={busy} onPress={() => run(async () => { const r = await rpc("dispatch_manifest", { p_manifest: cur.id, p: bus }); setMsg({ text: `${cur.code} sent: ${r.parcels} parcels on the bus. The destination hub has been told.`, kind: "success" }); setCur(null); })} />
      </>}

      {cur && mode === "in" && <>
        {cur.status === "departed" && <Button title="Bus has arrived" busy={busy} onPress={() => run(async () => { await rpc("arrive_manifest", { p_manifest: cur.id }); })} />}
        {cur.status === "arrived" && <>
          <Button title="Scan bags / parcels in" onPress={() => { setStatus(null); setScan(true); }} />
          <Field label="Note (required if anything is missing)" value={note} onChangeText={setNote} />
          <Button title="Close manifest" kind="secondary" busy={busy} onPress={() => run(async () => { const r = await rpc("close_manifest", { p_manifest: cur.id, p_note: note || null }); setMsg({ text: (r.missing ?? []).length ? `Closed. Missing: ${(r.missing as string[]).join(", ")}` : "Closed — everything received ✓", kind: "success" }); setCur(null); })} />
        </>}
      </>}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
      <Scanner visible={scan} continuous title={mode === "out" ? `Load ${cur?.code ?? ""}` : `Receive ${cur?.code ?? ""}`} status={status} onScan={onScan} onClose={() => { setScan(false); load(); }} />
    </Screen>
  );
}
