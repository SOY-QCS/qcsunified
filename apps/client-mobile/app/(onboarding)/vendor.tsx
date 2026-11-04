import { useState } from "react";
import { Image, Linking, Switch, Text, View } from "react-native";
import * as Location from "expo-location";
import { GhanaPostGps, ID_TYPES, VENDOR_CATEGORIES } from "@qcs/types";
import { Banner, Button, Choice, Field, Screen, Title, pickPhoto, supabase, uploadKyc, type PickedPhoto } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";
import { useCities, useTermsUrl } from "../../lib/cities";

type IdType = (typeof ID_TYPES)[number]["value"];

/** Business sign-up: business name, category, pickup address (with a GPS pin) and an ID document. */
export default function Vendor() {
  const { session, refresh } = useAuth();
  const cities = useCities();
  const [owner, setOwner] = useState("");
  const [business, setBusiness] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [gps, setGps] = useState("");
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [idType, setIdType] = useState<IdType | null>("ghana_card");
  const [idNumber, setIdNumber] = useState("");
  const [idPhoto, setIdPhoto] = useState<PickedPhoto | null>(null);
  const [optIn, setOptIn] = useState(false);
  const [terms, setTerms] = useState(false);
  const termsUrl = useTermsUrl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function usePhoneLocation() {
    setError(null);
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return setError("Allow location access so riders can find your pickup point.");
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setPin({ lat: loc.coords.latitude, lng: loc.coords.longitude });
  }

  async function takeIdPhoto(source: "camera" | "library") {
    try { const p = await pickPhoto(source); if (p) setIdPhoto(p); } catch (e) { setError((e as Error).message); }
  }

  async function submit() {
    setError(null);
    const uid = session!.user.id;
    if (owner.trim().length < 2) return setError("Enter your full name");
    if (business.trim().length < 2) return setError("Enter your business name");
    if (!category) return setError("Choose a business category");
    if (!city) return setError("Choose your city");
    if (address.trim().length < 3) return setError("Describe your pickup address");
    if (!pin) return setError("Tap “Use my current location” while you're at the pickup point");
    if (gps && !GhanaPostGps.safeParse(gps).success) return setError("Ghana Post GPS should look like GA-123-4567");
    if (!idType || idNumber.trim().length < 4) return setError("Enter your ID number");
    if (!idPhoto) return setError("Add a photo of your ID");
    if (!terms) return setError("Please accept the Terms & Conditions");

    setBusy(true);
    try {
      const idPath = await uploadKyc(uid, "business-id", idPhoto);
      const sb = supabase();
      const { error: pErr } = await sb.from("profiles").update({ full_name: owner.trim(), marketing_opt_in: optIn }).eq("id", uid);
      if (pErr) throw pErr;
      const { error: tErr } = await sb.rpc("accept_terms");
      if (tErr) throw tErr;
      const cityCode = cities.find((c) => c.id === city)!.code;
      const { error: vErr } = await sb.rpc("register_vendor", {
        p: {
          business_name: business.trim(), category, city_code: cityCode, contact_phone: session!.user.phone ? `+${session!.user.phone.replace(/^\+/, "")}` : null,
          id_type: idType, id_number: idNumber.trim(), id_doc_path: idPath,
          pickup: { formatted_address: address.trim(), landmark: landmark.trim() || null, ghana_post_gps: gps.trim() || null,
                    lat: pin.lat, lng: pin.lng, contact_name: owner.trim() },
        },
      });
      if (vErr) throw vErr;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title sub="We check every business before the first payout. You can start booking straight away.">Business account</Title>
      <Field label="Your full name" value={owner} onChangeText={setOwner} autoComplete="name" />
      <Field label="Business name" value={business} onChangeText={setBusiness} />
      <Choice label="Category" options={VENDOR_CATEGORIES.map((c) => ({ value: c, label: c }))} value={category} onChange={setCategory} />
      <Choice label="City" options={cities.map((c) => ({ value: c.id, label: c.name }))} value={city} onChange={setCity} />

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 8, marginBottom: 8 }}>Pickup point</Text>
      <Field label="Address" value={address} onChangeText={setAddress} placeholder="e.g. Shop 12, Oxford Street, Osu" />
      <Field label="Landmark (optional)" value={landmark} onChangeText={setLandmark} placeholder="e.g. opposite Koala supermarket" />
      <Field label="Ghana Post GPS (optional)" value={gps} onChangeText={setGps} autoCapitalize="characters" placeholder="GA-123-4567" />
      <Button title={pin ? `📍 Pin set (${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}) — tap to update` : "Use my current location"} kind="secondary" onPress={usePhoneLocation} />
      <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4, marginBottom: 12 }}>Stand at your pickup point when you tap this. You can fine-tune it on a map when booking.</Text>

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 8, marginBottom: 8 }}>Identity</Text>
      <Choice label="ID type" options={ID_TYPES} value={idType} onChange={setIdType} />
      <Field label="ID number" value={idNumber} onChangeText={setIdNumber} autoCapitalize="characters" placeholder="GHA-000000000-0" />
      {idPhoto ? <Image source={{ uri: idPhoto.uri }} style={{ width: "100%", height: 180, borderRadius: 10, marginBottom: 8 }} resizeMode="cover" /> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Button title={idPhoto ? "Retake photo" : "Take photo of ID"} kind="secondary" onPress={() => takeIdPhoto("camera")} /></View>
        <View style={{ flex: 1 }}><Button title="Choose from gallery" kind="secondary" onPress={() => takeIdPhoto("library")} /></View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 12 }}>
        <Text style={{ flex: 1 }}>Send me offers and news from QCS</Text>
        <Switch value={optIn} onValueChange={setOptIn} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Text style={{ flex: 1 }}>I agree to the <Text style={{ color: "#b8500f", textDecorationLine: "underline" }} onPress={() => Linking.openURL(termsUrl)}>QCS Terms &amp; Conditions</Text></Text>
        <Switch value={terms} onValueChange={setTerms} />
      </View>
      <Banner text={error} />
      <Button title="Create business account" onPress={submit} busy={busy} />
    </Screen>
  );
}
