import { useCallback, useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MOMO_NETWORKS, VEHICLE_TYPES, normalizeGhanaPhone } from "@qcs/types";
import { Banner, Button, Choice, Field, Screen, Title, pickPhoto, supabase, uploadKyc } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";
import { useCities } from "../../lib/cities";

type DocType = "photo" | "ghana_card" | "drivers_license" | "vehicle_photo";
type VehicleType = (typeof VEHICLE_TYPES)[number]["value"];

interface Draft {
  full_name: string; city_id: string | null; rider_type: "fleet" | "commission";
  ghana_card_number: string; licence_number: string;
  vehicle: { type: VehicleType | null; plate_number: string; make_model: string; colour: string; year: string };
  guarantor: { full_name: string; phone: string; relationship: string; address: string; ghana_card_number: string };
  momo: { network: string | null; number: string };
}
const EMPTY: Draft = {
  full_name: "", city_id: null, rider_type: "commission", ghana_card_number: "", licence_number: "",
  vehicle: { type: null, plate_number: "", make_model: "", colour: "", year: "" },
  guarantor: { full_name: "", phone: "", relationship: "", address: "", ghana_card_number: "" },
  momo: { network: null, number: "" },
};
const DRAFT_KEY = "qcs-rider-application";
const STEPS = ["About you", "Ghana Card", "Vehicle", "Licence", "Guarantor", "MoMo", "Submit"] as const;

/** Rider application, one step at a time. The draft is kept on the phone so nothing is lost if the app closes. */
export default function Apply() {
  const { session, account, refresh } = useAuth();
  const uid = session!.user.id;
  const cities = useCities();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(EMPTY);
  const [docs, setDocs] = useState<Partial<Record<DocType, string>>>({}); // doc type → storage path
  const [previews, setPreviews] = useState<Partial<Record<DocType, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsLicence = d.vehicle.type !== "ebike";
  const rejected = account?.rider?.status === "rejected";

  // Load saved draft + anything already on the server.
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(DRAFT_KEY);
      if (saved) setD({ ...EMPTY, ...JSON.parse(saved) });
      const { data } = await supabase().from("rider_documents").select("doc_type, storage_path, number").eq("rider_id", uid);
      const map: Partial<Record<DocType, string>> = {};
      (data ?? []).forEach((r) => { map[r.doc_type as DocType] = r.storage_path; });
      setDocs(map);
    })();
  }, [uid]);
  useEffect(() => { AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(d)); }, [d]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const ensureRider = useCallback(async () => {
    const { data } = await supabase().from("riders").select("id").eq("id", uid).maybeSingle();
    if (data) return;
    const { error } = await supabase().from("riders").insert({ id: uid, rider_type: d.rider_type, city_id: d.city_id });
    if (error) throw error;
  }, [uid, d.rider_type, d.city_id]);

  async function addDoc(type: DocType, source: "camera" | "library", number?: string) {
    setError(null);
    if (!d.city_id) return setError("Choose your city first");
    try {
      const photo = await pickPhoto(source);
      if (!photo) return;
      setBusy(true);
      await ensureRider();
      const path = await uploadKyc(uid, type, photo);
      const sb = supabase();
      await sb.from("rider_documents").delete().eq("rider_id", uid).eq("doc_type", type).eq("status", "pending");
      const { error } = await sb.from("rider_documents").insert({ rider_id: uid, doc_type: type, storage_path: path, number: number || null });
      if (error) throw error;
      setDocs((x) => ({ ...x, [type]: path }));
      setPreviews((x) => ({ ...x, [type]: photo.uri }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function PhotoSlot({ type, label, number }: { type: DocType; label: string; number?: string }) {
    const has = !!docs[type];
    return (
      <View style={{ marginBottom: 12 }}>
        <Text style={{ fontWeight: "600", marginBottom: 6 }}>{label} {has ? "✓" : ""}</Text>
        {previews[type] ? <Image source={{ uri: previews[type] }} style={{ width: "100%", height: 170, borderRadius: 10, marginBottom: 6 }} /> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}><Button title={has ? "Retake" : "Take photo"} kind="secondary" onPress={() => addDoc(type, "camera", number)} disabled={busy} /></View>
          <View style={{ flex: 1 }}><Button title="Gallery" kind="secondary" onPress={() => addDoc(type, "library", number)} disabled={busy} /></View>
        </View>
      </View>
    );
  }

  // Check each step before moving on.
  function problem(i: number): string | null {
    switch (STEPS[i]) {
      case "About you":
        if (d.full_name.trim().length < 3) return "Enter your full name as on your Ghana Card";
        if (!d.city_id) return "Choose the city you'll ride in";
        if (!docs.photo) return "Add a clear photo of your face";
        return null;
      case "Ghana Card":
        if (!/^GHA-?\d{9}-?\d$/i.test(d.ghana_card_number.trim())) return "Ghana Card number looks like GHA-000000000-0";
        if (!docs.ghana_card) return "Add a photo of your Ghana Card";
        return null;
      case "Vehicle":
        if (!d.vehicle.type) return "Choose your vehicle type";
        if (d.vehicle.type !== "ebike" && d.vehicle.plate_number.trim().length < 4) return "Enter the number plate";
        if (!docs.vehicle_photo) return "Add a photo of your vehicle showing the number plate";
        return null;
      case "Licence":
        if (!needsLicence) return null;
        if (d.licence_number.trim().length < 4) return "Enter your licence number";
        if (!docs.drivers_license) return "Add a photo of your driver's licence";
        return null;
      case "Guarantor": {
        const g = d.guarantor;
        if (g.full_name.trim().length < 3) return "Enter your guarantor's full name";
        if (!normalizeGhanaPhone(g.phone)) return "Enter your guarantor's Ghana phone number";
        if (!g.relationship.trim()) return "How do you know your guarantor?";
        if (g.address.trim().length < 3) return "Enter your guarantor's address";
        return null;
      }
      case "MoMo":
        if (!d.momo.network) return "Choose your MoMo network";
        if (!normalizeGhanaPhone(d.momo.number)) return "Enter your MoMo number";
        return null;
      default: return null;
    }
  }

  async function next() {
    const p = problem(step);
    if (p) return setError(p);
    setError(null);
    if (step === 0) { try { setBusy(true); await ensureRider(); } catch (e) { setBusy(false); return setError((e as Error).message); } setBusy(false); }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function submit() {
    for (let i = 0; i < STEPS.length - 1; i++) { const p = problem(i); if (p) { setStep(i); return setError(p); } }
    setBusy(true); setError(null);
    const sb = supabase();
    // Save the ID numbers on their documents.
    await sb.from("rider_documents").update({ number: d.ghana_card_number.trim().toUpperCase() }).eq("rider_id", uid).eq("doc_type", "ghana_card").eq("status", "pending");
    if (needsLicence) await sb.from("rider_documents").update({ number: d.licence_number.trim().toUpperCase() }).eq("rider_id", uid).eq("doc_type", "drivers_license").eq("status", "pending");
    const { error } = await sb.rpc("submit_rider_application", {
      p: {
        full_name: d.full_name.trim(), city_code: cities.find((c) => c.id === d.city_id)?.code, rider_type: d.rider_type,
        vehicle: { ...d.vehicle, year: d.vehicle.year ? Number(d.vehicle.year) : null },
        guarantor: { ...d.guarantor, phone: normalizeGhanaPhone(d.guarantor.phone) },
        momo: { network: d.momo.network, number: normalizeGhanaPhone(d.momo.number) },
      },
    });
    setBusy(false);
    if (error) return setError(error.message);
    await AsyncStorage.removeItem(DRAFT_KEY);
    await refresh();
  }

  const name = STEPS[step]!;
  return (
    <Screen>
      <Text style={{ color: colors.muted }}>Step {step + 1} of {STEPS.length}</Text>
      <Title>{name}</Title>
      {rejected && step === 0 && <Banner kind="error" text={`Your last application needs changes: ${account?.rider?.review_note ?? ""}`} />}

      {name === "About you" && <>
        <Field label="Full name (as on Ghana Card)" value={d.full_name} onChangeText={(v) => set("full_name", v)} autoComplete="name" />
        <Choice label="City" options={cities.map((c) => ({ value: c.id, label: c.name }))} value={d.city_id} onChange={(v) => set("city_id", v)} />
        <Choice label="How will you ride?" value={d.rider_type} onChange={(v) => set("rider_type", v)}
          options={[{ value: "commission", label: "Independent (earn commission)" }, { value: "fleet", label: "QCS fleet rider" }] as const} />
        <PhotoSlot type="photo" label="Clear photo of your face" />
      </>}

      {name === "Ghana Card" && <>
        <Field label="Ghana Card number" value={d.ghana_card_number} onChangeText={(v) => set("ghana_card_number", v)} autoCapitalize="characters" placeholder="GHA-000000000-0" />
        <PhotoSlot type="ghana_card" label="Photo of the front of your Ghana Card" />
      </>}

      {name === "Vehicle" && <>
        <Choice label="Vehicle type" options={VEHICLE_TYPES} value={d.vehicle.type} onChange={(v) => set("vehicle", { ...d.vehicle, type: v })} />
        {d.vehicle.type !== "ebike" && <Field label="Number plate" value={d.vehicle.plate_number} onChangeText={(v) => set("vehicle", { ...d.vehicle, plate_number: v })} autoCapitalize="characters" placeholder="GR 1234-24" />}
        <Field label="Make and model" value={d.vehicle.make_model} onChangeText={(v) => set("vehicle", { ...d.vehicle, make_model: v })} placeholder="e.g. Haojue 125" />
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}><Field label="Colour" value={d.vehicle.colour} onChangeText={(v) => set("vehicle", { ...d.vehicle, colour: v })} /></View>
          <View style={{ flex: 1 }}><Field label="Year" keyboardType="number-pad" maxLength={4} value={d.vehicle.year} onChangeText={(v) => set("vehicle", { ...d.vehicle, year: v })} /></View>
        </View>
        <PhotoSlot type="vehicle_photo" label="Photo of your vehicle (number plate visible)" />
      </>}

      {name === "Licence" && (needsLicence ? <>
        <Field label="Driver's licence number" value={d.licence_number} onChangeText={(v) => set("licence_number", v)} autoCapitalize="characters" />
        <PhotoSlot type="drivers_license" label="Photo of your driver's licence" />
      </> : <Banner kind="info" text="Electric bikes don't need a driver's licence. Tap Next." />)}

      {name === "Guarantor" && <>
        <Text style={{ color: colors.muted, marginBottom: 12 }}>Someone who knows you well and can vouch for you. QCS may call them.</Text>
        <Field label="Guarantor's full name" value={d.guarantor.full_name} onChangeText={(v) => set("guarantor", { ...d.guarantor, full_name: v })} />
        <Field label="Guarantor's phone" keyboardType="phone-pad" value={d.guarantor.phone} onChangeText={(v) => set("guarantor", { ...d.guarantor, phone: v })} placeholder="024 123 4567" />
        <Field label="Relationship" value={d.guarantor.relationship} onChangeText={(v) => set("guarantor", { ...d.guarantor, relationship: v })} placeholder="e.g. Uncle, Pastor, Former employer" />
        <Field label="Guarantor's address" value={d.guarantor.address} onChangeText={(v) => set("guarantor", { ...d.guarantor, address: v })} />
        <Field label="Guarantor's Ghana Card number (optional)" value={d.guarantor.ghana_card_number} onChangeText={(v) => set("guarantor", { ...d.guarantor, ghana_card_number: v })} autoCapitalize="characters" />
      </>}

      {name === "MoMo" && <>
        <Text style={{ color: colors.muted, marginBottom: 12 }}>Your earnings are paid to this Mobile Money number every week.</Text>
        <Choice label="Network" options={MOMO_NETWORKS.map((n) => ({ value: n, label: n }))} value={d.momo.network} onChange={(v) => set("momo", { ...d.momo, network: v })} />
        <Field label="MoMo number" keyboardType="phone-pad" value={d.momo.number} onChangeText={(v) => set("momo", { ...d.momo, number: v })} placeholder="024 123 4567"
          hint="Should be registered in your own name" />
      </>}

      {name === "Submit" && <>
        <Text style={{ marginBottom: 6 }}>✓ {d.full_name} · {cities.find((c) => c.id === d.city_id)?.name}</Text>
        <Text style={{ marginBottom: 6 }}>✓ Ghana Card {d.ghana_card_number.toUpperCase()}</Text>
        <Text style={{ marginBottom: 6 }}>✓ {VEHICLE_TYPES.find((t) => t.value === d.vehicle.type)?.label} {d.vehicle.plate_number.toUpperCase()}</Text>
        {needsLicence && <Text style={{ marginBottom: 6 }}>✓ Licence {d.licence_number.toUpperCase()}</Text>}
        <Text style={{ marginBottom: 6 }}>✓ Guarantor: {d.guarantor.full_name}</Text>
        <Text style={{ marginBottom: 6 }}>✓ MoMo: {d.momo.network} {normalizeGhanaPhone(d.momo.number)}</Text>
        <Text style={{ color: colors.muted, marginTop: 8 }}>By submitting you confirm these details are true. False documents mean your account will be closed.</Text>
      </>}

      <Banner text={error} />
      {name === "Submit"
        ? <Button title="Submit application" onPress={submit} busy={busy} />
        : <Button title="Next" onPress={next} busy={busy} />}
      {step > 0 && <Button title="Back" kind="secondary" onPress={() => { setError(null); setStep((s) => s - 1); }} disabled={busy} />}
      {step === 0 && <Button title="Sign out" kind="secondary" onPress={() => supabase().auth.signOut()} />}
    </Screen>
  );
}
