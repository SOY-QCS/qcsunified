import { useState } from "react";
import { Image, Linking, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { File, Paths } from "expo-file-system";
import { Banner, Button, Choice, Field, Screen, Title, pickPhoto, type PickedPhoto } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { FAILED_REASONS, navigationUrl } from "@qcs/types";
import { useJob } from "../../lib/job";
import { here } from "../../lib/location";
import { act } from "../../lib/queue";
import { SignaturePad } from "../../components/signature-pad";

const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;

/** One drop-off: navigate → arrived → code → signature → (photo) → (cash) → delivered. Or: failed attempt. */
export default function Deliver() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { job, refresh, setJob } = useJob();
  const o = job?.orders.find((x) => x.id === id);
  const [code, setCode] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [overrideNote, setOverrideNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "info" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!o) return <Screen><Text>Loading…</Text></Screen>;

  const patch = (p: Partial<typeof o>) => setJob((j) => j && { ...j, orders: j.orders.map((x) => (x.id === o.id ? { ...x, ...p } : x)) });
  async function run(fn: () => Promise<void>) {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); } finally { setBusy(false); }
  }
  const offlineNote = (r: unknown) => { if (r === null) setMsg({ text: "No signal — saved on your phone and will send automatically.", kind: "info" }); };

  const arrived = () => run(async () => {
    const p = await here();
    offlineNote(await act({ type: "status", order_id: o.id, to: "ARRIVED_AT_DROPOFF", lng: p?.lng, lat: p?.lat }));
    patch({ status: "ARRIVED_AT_DROPOFF" });
  });
  const checkCode = () => run(async () => {
    const r = await act({ type: "code", order_id: o.id, code: code.trim() });
    if (r === null) { setMsg({ text: "No signal: the code will be checked when you're back online. You can carry on.", kind: "info" }); patch({ otp_verified: true }); return; }
    if (r.ok) { patch({ otp_verified: true }); setMsg({ text: "Code correct ✓", kind: "success" }); }
    else setMsg({ text: `Wrong code. ${r.attempts_left} tries left.`, kind: "error" });
  });
  const saveSignature = (svg: string) => run(async () => {
    const file = new File(Paths.cache, `sig-${o.id}.svg`);
    file.write(svg);
    const path = `${o.id}/signature-${Date.now()}.svg`;
    offlineNote(await act({ type: "pod", order_id: o.id, signature_path: path }, [{ field: "signature_path", localUri: file.uri, path, contentType: "image/svg+xml" }]));
    patch({ signature: true });
  });
  const takePhoto = () => run(async () => {
    const p = await pickPhoto("camera");
    if (!p) return;
    setPhoto(p);
    const path = `${o.id}/photo-${Date.now()}.jpg`;
    offlineNote(await act({ type: "pod", order_id: o.id, photo_path: path }, [{ field: "photo_path", localUri: p.uri, path, contentType: "image/jpeg" }]));
    patch({ photo: true });
  });
  const collectCash = () => run(async () => {
    offlineNote(await act({ type: "cod", order_id: o.id, amount: o.cod_amount, method: "cash" }));
    patch({ cod_collected: true });
  });
  const delivered = () => run(async () => {
    const p = await here();
    offlineNote(await act({ type: "status", order_id: o.id, to: "DELIVERED", lng: p?.lng, lat: p?.lat }));
    patch({ status: "DELIVERED" });
    setTimeout(refresh, 1500);
    router.back();
  });
  const failed = () => run(async () => {
    if (!reason) throw new Error("Choose a reason");
    const p = await here();
    offlineNote(await act({ type: "status", order_id: o.id, to: "FAILED_ATTEMPT", reason, lng: p?.lng, lat: p?.lat }));
    patch({ status: "FAILED_ATTEMPT" });
    router.back();
  });
  const askOverride = () => run(async () => {
    if (!photo) throw new Error("Take a photo at the door first");
    if (overrideNote.trim().length < 5) throw new Error("Explain why there's no code");
    const path = `${o.id}/override-${Date.now()}.jpg`;
    offlineNote(await act({ type: "override", order_id: o.id, reason: overrideNote.trim(), photo_path: path }, [{ field: "photo_path", localUri: photo.uri, path, contentType: "image/jpeg" }]));
    setMsg({ text: "Override requested. Dispatch will approve it — then you can mark delivered.", kind: "info" });
  });

  const atDoor = o.status === "ARRIVED_AT_DROPOFF";
  const ready = o.otp_verified && o.signature && (!o.pod_photo_required || o.photo) && (!o.cod_amount || o.cod_collected);
  return (
    <Screen>
      <Title sub={`${o.tracking_number}${o.fragile ? " · FRAGILE" : ""}`}>{o.recipient_name}</Title>
      <Text style={{ fontWeight: "700" }}>{o.dropoff_address}</Text>
      <Text style={{ color: colors.muted }}>{[o.landmark, o.gps].filter(Boolean).join(" · ")}{o.note ? `\nNote: ${o.note}` : ""}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Button title="Navigate" kind="secondary" onPress={() => Linking.openURL(navigationUrl({ lat: o.dropoff_lat, lng: o.dropoff_lng }))} /></View>
        <View style={{ flex: 1 }}><Button title="Call" kind="secondary" onPress={() => Linking.openURL(`tel:${o.recipient_phone}`)} /></View>
      </View>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />

      {!atDoor && !failing && <Button title="I've arrived" onPress={arrived} busy={busy} />}

      {atDoor && !failing && <>
        <Text style={{ fontSize: 17, fontWeight: "800", marginTop: 12 }}>{o.otp_verified ? "✅" : "1."} Delivery code</Text>
        {!o.otp_verified && <>
          <Field label="Ask the recipient for the 4-digit code from their SMS" keyboardType="number-pad" maxLength={4} value={code} onChangeText={setCode} />
          <Button title="Check code" onPress={checkCode} busy={busy} disabled={code.length !== 4} />
        </>}
        <Text style={{ fontSize: 17, fontWeight: "800", marginTop: 12 }}>{o.signature ? "✅" : "2."} Signature</Text>
        {!o.signature && <SignaturePad onDone={saveSignature} />}
        <Text style={{ fontSize: 17, fontWeight: "800", marginTop: 12 }}>{o.photo ? "✅" : "3."} Photo{o.pod_photo_required ? " (required)" : " (optional)"}</Text>
        {photo && <Image source={{ uri: photo.uri }} style={{ width: "100%", height: 160, borderRadius: 10 }} />}
        {!o.photo && <Button title="Take photo of the parcel at the door" kind="secondary" onPress={takePhoto} busy={busy} />}
        {o.cod_amount > 0 && <>
          <Text style={{ fontSize: 17, fontWeight: "800", marginTop: 12 }}>{o.cod_collected ? "✅" : "4."} Cash on delivery</Text>
          {!o.cod_collected && <View style={{ backgroundColor: "#fbeee4", borderRadius: 12, padding: 14 }}>
            <Text style={{ fontSize: 22, fontWeight: "900" }}>Collect {ghs(o.cod_amount)}</Text>
            <Text style={{ color: colors.muted }}>Count it in front of the recipient. Remit to QCS by end of day.</Text>
            <Button title={`I've collected ${ghs(o.cod_amount)} cash`} onPress={collectCash} busy={busy} />
          </View>}
        </>}
        <Button title={ready ? "Mark delivered" : "Finish the steps above"} onPress={delivered} disabled={!ready} busy={busy} />
        <Button title="Delivery failed" kind="danger" onPress={() => setFailing(true)} />
        <Text style={{ fontWeight: "700", marginTop: 16 }}>Recipient has no code?</Text>
        <Field label="What happened" value={overrideNote} onChangeText={setOverrideNote} placeholder="e.g. Recipient's phone is off; confirmed ID" />
        <Button title={photo ? "Ask dispatch for an override" : "Take a photo first, then ask for an override"} kind="secondary" onPress={photo ? askOverride : takePhoto} busy={busy} />
      </>}

      {failing && <>
        <Choice label="Why couldn't you deliver?" options={FAILED_REASONS} value={reason} onChange={setReason} />
        <Button title="Report failed attempt" kind="danger" onPress={failed} busy={busy} disabled={!reason} />
        <Button title="Back" kind="secondary" onPress={() => setFailing(false)} />
      </>}
      <Button title="Back to job" kind="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
