import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import * as Location from "expo-location";
import { Banner, Button, Field } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { api } from "../lib/api";

export interface PlaceValue {
  address_id?: string | null; formatted_address: string; lat: number | null; lng: number | null;
  ghana_post_gps: string; landmark: string; google_place_id?: string | null;
}
export const emptyPlace = (): PlaceValue => ({ formatted_address: "", lat: null, lng: null, ghana_post_gps: "", landmark: "" });

interface Suggestion { place_id: string; main: string; secondary: string }
interface Saved { id: string; label: string | null; contact_name: string | null; contact_phone: string | null; formatted_address: string; landmark: string | null; ghana_post_gps: string | null; lat: number; lng: number }

const ACCRA = { latitude: 5.6037, longitude: -0.187 };

/**
 * Search (Google, Ghana only) or pick a saved address, or use the phone's location.
 * Then drag the pin on the map to the exact gate — that's where the rider goes.
 */
export function AddressPicker({ label, value, onChange, vendorId, onSaved }: {
  label: string; value: PlaceValue; onChange: (v: PlaceValue) => void; vendorId?: string | null;
  onSaved?: (c: { contact_name: string | null; contact_phone: string | null }) => void;
}) {
  const session = useMemo(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`, []);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function search(text: string) {
    onChange({ ...value, formatted_address: text, address_id: null });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const qs = `q=${encodeURIComponent(text)}&session=${session}${vendorId ? `&vendor_id=${vendorId}` : ""}`;
      const [g, s] = await Promise.all([
        text.length >= 3 ? api<{ suggestions: Suggestion[] }>(`/api/v1/places/autocomplete?${qs}`).catch(() => ({ suggestions: [] })) : Promise.resolve({ suggestions: [] }),
        api<{ addresses: Saved[] }>(`/api/v1/addresses?${qs}`).catch(() => ({ addresses: [] })),
      ]);
      setSugs(g.suggestions); setSaved(s.addresses.slice(0, 5));
    }, 350);
  }

  async function pick(s: Suggestion) {
    setSugs([]); setSaved([]);
    try {
      const d = await api<{ formatted_address: string; lat: number; lng: number; google_place_id: string }>(`/api/v1/places/details?id=${encodeURIComponent(s.place_id)}&session=${session}`);
      onChange({ ...value, ...d, address_id: null });
    } catch { setError("Couldn't load that place. Try another or use your location."); }
  }

  function pickSaved(a: Saved) {
    setSugs([]); setSaved([]);
    onChange({ address_id: a.id, formatted_address: a.formatted_address, lat: a.lat, lng: a.lng, ghana_post_gps: a.ghana_post_gps ?? "", landmark: a.landmark ?? "" });
    onSaved?.({ contact_name: a.contact_name, contact_phone: a.contact_phone });
  }

  async function here() {
    setError(null);
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return setError("Allow location access, or search for the address.");
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    onChange({ ...value, lat: loc.coords.latitude, lng: loc.coords.longitude, address_id: null });
  }

  const pin = value.lat != null && value.lng != null ? { latitude: value.lat, longitude: value.lng } : null;
  return (
    <View style={{ marginBottom: 8 }}>
      <Field label={label} value={value.formatted_address} onChangeText={search} placeholder="Search a place, street or saved customer" />
      {(saved.length > 0 || sugs.length > 0) && (
        <View style={{ backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e6e1da", marginTop: -8, marginBottom: 12 }}>
          {saved.map((a) => (
            <Pressable key={a.id} onPress={() => pickSaved(a)} style={{ padding: 12, borderBottomWidth: 1, borderColor: "#f0ebe4" }}>
              <Text style={{ fontWeight: "700" }}>★ {a.contact_name ?? a.label}</Text><Text style={{ color: colors.muted }}>{a.formatted_address}</Text>
            </Pressable>
          ))}
          {sugs.map((s) => (
            <Pressable key={s.place_id} onPress={() => pick(s)} style={{ padding: 12, borderBottomWidth: 1, borderColor: "#f0ebe4" }}>
              <Text style={{ fontWeight: "700" }}>{s.main}</Text><Text style={{ color: colors.muted }}>{s.secondary}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Button title={pin ? "📍 Use my current location instead" : "📍 Use my current location"} kind="secondary" onPress={here} />
      {pin && (
        <View style={{ height: 180, borderRadius: 12, overflow: "hidden", marginTop: 8 }}>
          <MapView style={{ flex: 1 }} region={{ ...pin, latitudeDelta: 0.006, longitudeDelta: 0.006 }}>
            <Marker coordinate={pin} draggable pinColor={colors.primary}
              onDragEnd={(e) => onChange({ ...value, lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude, address_id: null })} />
          </MapView>
          <Text style={{ position: "absolute", bottom: 6, left: 8, backgroundColor: "#fffd", paddingHorizontal: 6, borderRadius: 4, fontSize: 12 }}>Hold and drag the pin to the exact gate</Text>
        </View>
      )}
      {!pin && <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>Search or use your location, then fine-tune the pin on the map.</Text>}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <View style={{ flex: 1 }}><Field label="Landmark" value={value.landmark} onChangeText={(t) => onChange({ ...value, landmark: t })} placeholder="Near…" /></View>
        <View style={{ flex: 1 }}><Field label="Ghana Post GPS" value={value.ghana_post_gps} autoCapitalize="characters" onChangeText={(t) => onChange({ ...value, ghana_post_gps: t.toUpperCase() })} placeholder="GA-123-4567" /></View>
      </View>
      <Banner text={error} />
    </View>
  );
}
export { ACCRA };
