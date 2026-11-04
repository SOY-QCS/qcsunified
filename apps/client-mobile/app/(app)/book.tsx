import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PACKAGE_SIZES, normalizeGhanaPhone } from "@qcs/types";
import { Banner, Button, Choice, Field, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { AddressPicker, emptyPlace, type PlaceValue } from "../../components/address-picker";
import { api, ApiProblem, ghs, type BookingResult, type QuoteResult } from "../../lib/api";
import { useAuth } from "../../lib/auth";

interface Stop { place: PlaceValue; name: string; phone: string; kg: string; size: string; fragile: boolean; item: string; value: string; cod: string; note: string }
const newStop = (): Stop => ({ place: emptyPlace(), name: "", phone: "", kg: "1", size: "small", fragile: false, item: "", value: "", cod: "", note: "" });
const pes = (t: string) => Math.round(Number(t || 0) * 100);

const WHEN = [{ value: "now", label: "Now" }, { value: "1h", label: "In 1 hour" }, { value: "tmr9", label: "Tomorrow 9:00" }, { value: "tmr14", label: "Tomorrow 14:00" }] as const;
function whenToIso(w: string): string | null {
  const d = new Date();
  if (w === "1h") return new Date(d.getTime() + 3600_000).toISOString();
  if (w === "tmr9" || w === "tmr14") { // Accra = UTC
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, w === "tmr9" ? 9 : 14));
    return t.toISOString();
  }
  return null;
}

/** Book: service → pickup → drop-off(s) → parcel → who pays → live price → confirm. */
export default function Book() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { session, account } = useAuth();
  const vendor = mode === "business" ? account?.vendor ?? null : null;
  const myPhone = session?.user.phone ? `+${session.user.phone.replace(/^\+/, "")}` : "";

  const [service, setService] = useState<"express" | "ecommerce">(vendor ? "ecommerce" : "express");
  const [pickup, setPickup] = useState<PlaceValue>(emptyPlace());
  const [sender, setSender] = useState({ name: account?.profile?.full_name ?? "", phone: myPhone });
  const [pickupNote, setPickupNote] = useState("");
  const [stops, setStops] = useState<Stop[]>([newStop()]);
  const [when, setWhen] = useState<string>("now");
  const [payer, setPayer] = useState<string>(vendor ? (vendor.account_type === "corporate" ? "corporate_invoice" : "vendor_wallet") : "sender");
  const [method, setMethod] = useState<string>("momo");
  const [promo, setPromo] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Businesses start from their saved pickup point.
  useEffect(() => {
    if (!vendor) return;
    (async () => {
      const { data: v } = await supabase().from("vendors").select("default_pickup_address_id").eq("id", vendor.id).single();
      if (!v?.default_pickup_address_id) return;
      const { data: a } = await supabase().from("addresses").select("id, formatted_address, lat, lng, ghana_post_gps, landmark").eq("id", v.default_pickup_address_id).single();
      if (a) setPickup({ address_id: a.id, formatted_address: a.formatted_address, lat: a.lat, lng: a.lng, ghana_post_gps: a.ghana_post_gps ?? "", landmark: a.landmark ?? "" });
    })();
  }, [vendor]);

  const change = <T,>(fn: (v: T) => void) => (v: T) => { setQuote(null); fn(v); };
  const setStop = (i: number, s: Partial<Stop>) => { setQuote(null); setStops((all) => all.map((x, j) => (j === i ? { ...x, ...s } : x))); };
  const max = service === "express" ? 1 : 25;

  function body() {
    const local: string[] = [];
    if (pickup.lat == null) local.push("Pickup: set the location");
    stops.forEach((s, i) => {
      if (s.place.lat == null) local.push(`Drop-off ${i + 1}: set the location`);
      if (!normalizeGhanaPhone(s.phone)) local.push(`Drop-off ${i + 1}: recipient's phone number`);
    });
    if (local.length) throw new ApiProblem("Please check", local);
    const payment_method = payer === "vendor_wallet" ? "wallet" : payer === "corporate_invoice" ? "invoice" : payer === "recipient" ? "cash" : method;
    return {
      service, vendor_id: vendor?.id ?? null, payer, payment_method, promo_code: promo || null, scheduled_at: whenToIso(when),
      pickup: { ...pickup, contact_name: sender.name, contact_phone: sender.phone, instructions: pickupNote || null },
      dropoffs: stops.map((s) => ({ ...s.place, contact_name: s.name, contact_phone: s.phone, instructions: s.note || null,
        weight_g: Math.round(Number(s.kg || 0) * 1000), size: s.size, fragile: s.fragile, item_description: s.item || null,
        item_value: pes(s.value), cod_amount: pes(s.cod) })),
    };
  }

  async function getPrice() {
    setBusy(true); setProblems([]);
    try { setQuote(await api<QuoteResult>("/api/v1/quotes", { method: "POST", body: JSON.stringify(body()) })); }
    catch (e) { const a = e as ApiProblem; setProblems(a.details?.length ? a.details : [a.message]); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true); setProblems([]);
    try {
      const r = await api<BookingResult>("/api/v1/bookings", { method: "POST", body: JSON.stringify({ quote_id: quote.quote_id }) });
      router.replace({ pathname: "/booked", params: { data: JSON.stringify(r) } });
    } catch (e) { setProblems([(e as Error).message]); setBusy(false); }
  }

  return (
    <Screen>
      <Title sub={vendor ? vendor.business_name : "Personal"}>Send a parcel</Title>
      {vendor && <Choice label="Service" value={service} onChange={change((v: "express" | "ecommerce") => { setService(v); if (v === "express") setStops((s) => s.slice(0, 1)); })}
        options={[{ value: "ecommerce", label: "E-commerce trip (up to 25)" }, { value: "express", label: "Express now" }] as const} />}
      <Text style={{ color: colors.muted, marginBottom: 12 }}>{service === "express" ? "A bike picks up now. Max 15 kg. Price is locked when you confirm." : "Priced per drop-off. You pay per successful delivery."}</Text>

      <Text style={{ fontSize: 18, fontWeight: "800", marginBottom: 8 }}>Pickup</Text>
      <AddressPicker label="Pickup address" value={pickup} onChange={change(setPickup)} vendorId={vendor?.id} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}><Field label="Your name" value={sender.name} onChangeText={(t) => setSender({ ...sender, name: t })} /></View>
        <View style={{ flex: 1 }}><Field label="Your phone" keyboardType="phone-pad" value={sender.phone} onChangeText={(t) => setSender({ ...sender, phone: t })} /></View>
      </View>
      <Field label="Note for the rider (optional)" value={pickupNote} onChangeText={setPickupNote} placeholder="e.g. Ask for Ama at the counter" />
      <Choice label="When" options={WHEN} value={when} onChange={change(setWhen)} />

      {stops.map((s, i) => (
        <View key={i} style={{ borderLeftWidth: 4, borderColor: colors.primary, paddingLeft: 10, marginVertical: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 18, fontWeight: "800" }}>Drop-off {stops.length > 1 ? i + 1 : ""}</Text>
            {stops.length > 1 && <Text onPress={() => { setQuote(null); setStops(stops.filter((_, j) => j !== i)); }} style={{ color: colors.danger }}>Remove</Text>}
          </View>
          <AddressPicker label="Delivery address" value={s.place} onChange={(v) => setStop(i, { place: v })} vendorId={vendor?.id}
            onSaved={(c) => setStop(i, { name: c.contact_name ?? s.name, phone: c.contact_phone ?? s.phone })} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="Recipient name" value={s.name} onChangeText={(t) => setStop(i, { name: t })} /></View>
            <View style={{ flex: 1 }}><Field label="Recipient phone" keyboardType="phone-pad" value={s.phone} onChangeText={(t) => setStop(i, { phone: t })} placeholder="024 123 4567" /></View>
          </View>
          <Choice label="Size" options={PACKAGE_SIZES.map((z) => ({ value: z.value, label: z.label }))} value={s.size} onChange={(v) => setStop(i, { size: v })} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="Weight (kg)" keyboardType="decimal-pad" value={s.kg} onChangeText={(t) => setStop(i, { kg: t })} /></View>
            <View style={{ flex: 1 }}><Field label="Item value (GHS)" keyboardType="decimal-pad" value={s.value} onChangeText={(t) => setStop(i, { value: t })} /></View>
          </View>
          {vendor && <Field label="Cash to collect (COD, GHS)" keyboardType="decimal-pad" value={s.cod} onChangeText={(t) => setStop(i, { cod: t })} placeholder="Leave empty if paid" />}
          <Field label="What's inside (optional)" value={s.item} onChangeText={(t) => setStop(i, { item: t })} />
          <Field label="Delivery instructions (optional)" value={s.note} onChangeText={(t) => setStop(i, { note: t })} placeholder="e.g. Call on arrival" />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text>Fragile — handle with care</Text><Switch value={s.fragile} onValueChange={(v) => setStop(i, { fragile: v })} />
          </View>
        </View>
      ))}
      {stops.length < max && <Button title={`+ Add another drop-off (${stops.length}/${max})`} kind="secondary" onPress={() => { setQuote(null); setStops([...stops, newStop()]); }} />}

      <Text style={{ fontSize: 18, fontWeight: "800", marginTop: 16, marginBottom: 8 }}>Payment</Text>
      <Choice label="Who pays the delivery fee?" value={payer} onChange={change(setPayer)} options={vendor
        ? [...(vendor.account_type === "corporate" ? [{ value: "corporate_invoice", label: "Monthly invoice" }] : []), { value: "vendor_wallet", label: "Business wallet" }, { value: "sender", label: "Pay now" }]
        : [{ value: "sender", label: "I pay" }, ...(stops.length === 1 ? [{ value: "recipient", label: "Recipient pays cash" }] : [])]} />
      {payer === "sender" && <Choice label="How" value={method} onChange={change(setMethod)}
        options={[{ value: "momo", label: "Mobile Money" }, { value: "card", label: "Card" }, { value: "cash", label: "Cash at pickup" }, ...(vendor ? [] : [{ value: "wallet", label: "QCS wallet" }])]} />}
      <Field label="Promo code (optional)" value={promo} autoCapitalize="characters" onChangeText={(t) => { setQuote(null); setPromo(t.toUpperCase()); }} />

      {problems.length > 0 && <Banner text={problems.join("\n")} />}
      {!quote ? <Button title="Get price" onPress={getPrice} busy={busy} /> : (
        <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#e6e1da", marginTop: 8 }}>
          {quote.stops.length > 1 && quote.stops.map((st, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}><Text>Drop-off {i + 1}</Text><Text>{ghs(st.netPesewas)}</Text></View>
          ))}
          {quote.stops.length === 1 && quote.stops[0]!.lines.filter((l) => l.pesewas !== 0).map((l, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: colors.muted }}>{l.label}</Text><Text style={{ color: colors.muted }}>{ghs(l.pesewas)}</Text></View>
          ))}
          {quote.discountPesewas > 0 && <View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text>Promo</Text><Text>−{ghs(quote.discountPesewas)}</Text></View>}
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
            <Text style={{ fontSize: 20, fontWeight: "800" }}>Total</Text><Text style={{ fontSize: 20, fontWeight: "800" }}>{ghs(quote.totalPesewas)}</Text>
          </View>
          {quote.notes.map((n) => <Text key={n} style={{ color: colors.muted, marginTop: 4 }}>• {n}</Text>)}
          <Button title={`Confirm booking`} onPress={confirm} busy={busy} />
          <Button title="Change details" kind="secondary" onPress={() => setQuote(null)} disabled={busy} />
        </View>
      )}
      <Button title="Cancel" kind="secondary" onPress={() => router.back()} disabled={busy} />
    </Screen>
  );
}
