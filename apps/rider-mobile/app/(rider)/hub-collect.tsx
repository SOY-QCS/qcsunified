import { useState } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { File, Paths } from "expo-file-system";
import { Banner, Button, Field, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { Scanner } from "../../components/scanner";
import { SignaturePad } from "../../components/signature-pad";
import { hubScan } from "../../lib/hub";

/** Recipient collects at the hub: find the parcel, check the 4-digit code from their SMS, take their signature. */
export default function HubCollect() {
  const router = useRouter();
  const { hub } = useLocalSearchParams<{ hub: string }>();
  const [code, setCode] = useState("");
  const [parcel, setParcel] = useState<{ id: string; tracking_number: string; recipient_name: string; status: string } | null>(null);
  const [otp, setOtp] = useState("");
  const [scan, setScan] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);

  async function find(tn: string) {
    setMsg(null);
    const { data } = await supabase().from("orders").select("id, tracking_number, recipient_name, status").eq("tracking_number", tn.trim().toUpperCase()).maybeSingle();
    if (!data) return setMsg({ text: "Parcel not found", kind: "error" });
    if (data.status !== "READY_FOR_COLLECTION") return setMsg({ text: `${data.tracking_number} is ${data.status.toLowerCase().replaceAll("_", " ")}, not ready for collection`, kind: "error" });
    setParcel(data);
  }
  async function collect(svg: string) {
    if (!parcel) return;
    setBusy(true);
    try {
      const file = new File(Paths.cache, `sig-${parcel.id}.svg`); file.write(svg);
      const path = `${parcel.id}/signature-hub-${Date.now()}.svg`;
      const r = await hubScan({ type: "collect", hub_id: hub, code: parcel.tracking_number, otp, signature_path: path },
                              [{ field: "signature_path", localUri: file.uri, path, contentType: "image/svg+xml" }]);
      if (r === null) setMsg({ text: "No signal: saved — it will be recorded when you're back online. You can hand the parcel over.", kind: "info" });
      else if (!r.ok) { setMsg({ text: `${r.error}${r.attempts_left != null ? ` — ${r.attempts_left} tries left` : ""}`, kind: "error" }); return; }
      else setMsg({ text: `${parcel.tracking_number} collected by ${parcel.recipient_name} ✓`, kind: "success" });
      setParcel(null); setOtp(""); setCode("");
    } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Title sub="The recipient shows their SMS code and signs">Collection at the hub</Title>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />
      {!parcel ? <>
        <Field label="Tracking number" value={code} autoCapitalize="characters" onChangeText={setCode} />
        <Button title="Find parcel" onPress={() => find(code)} disabled={code.length < 6} />
        <Button title="Scan the parcel label" kind="secondary" onPress={() => setScan(true)} />
      </> : <>
        <Text style={{ fontSize: 18, fontWeight: "800" }}>{parcel.tracking_number}</Text>
        <Text style={{ color: colors.muted, marginBottom: 8 }}>For {parcel.recipient_name} — check their ID if unsure.</Text>
        <Field label="4-digit code from the recipient's SMS" keyboardType="number-pad" maxLength={4} value={otp} onChangeText={setOtp} />
        {otp.length === 4 && <><Text style={{ fontWeight: "700", marginTop: 8 }}>Recipient signs here</Text><SignaturePad onDone={collect} /></>}
        <Button title="Cancel" kind="secondary" onPress={() => setParcel(null)} disabled={busy} />
      </>}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
      <Scanner visible={scan} onScan={(c) => { setScan(false); setCode(c); find(c); }} onClose={() => setScan(false)} />
    </Screen>
  );
}
