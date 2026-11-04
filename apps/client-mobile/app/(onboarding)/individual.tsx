import { useState } from "react";
import { Linking, Switch, Text, View } from "react-native";
import { Banner, Button, Choice, Field, Screen, Title, supabase } from "@qcs/mobile";
import { useAuth } from "../../lib/auth";
import { useCities, useTermsUrl } from "../../lib/cities";

export default function Individual() {
  const { session, refresh } = useAuth();
  const cities = useCities();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState<string | null>(null);
  const [optIn, setOptIn] = useState(false);
  const [terms, setTerms] = useState(false);
  const termsUrl = useTermsUrl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (name.trim().length < 2) return setError("Enter your full name");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return setError("That email doesn't look right");
    if (!city) return setError("Choose your city");
    if (!terms) return setError("Please accept the Terms & Conditions");
    setBusy(true);
    const t = await supabase().rpc("accept_terms");
    if (t.error) { setBusy(false); return setError(t.error.message); }
    const { error } = await supabase().from("profiles")
      .update({ full_name: name.trim(), email: email.trim() || null, city_id: city, marketing_opt_in: optIn })
      .eq("id", session!.user.id);
    if (error) { setBusy(false); return setError(error.message); }
    await refresh();
    setBusy(false);
  }

  return (
    <Screen>
      <Title sub="Just a few details and you're ready to send.">About you</Title>
      <Field label="Full name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" />
      <Field label="Email (optional)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" hint="For receipts" />
      <Choice label="City" options={cities.map((c) => ({ value: c.id, label: c.name }))} value={city} onChange={setCity} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 8 }}>
        <Text style={{ flex: 1 }}>Send me offers and news from QCS</Text>
        <Switch value={optIn} onValueChange={setOptIn} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Text style={{ flex: 1 }}>I agree to the <Text style={{ color: "#b8500f", textDecorationLine: "underline" }} onPress={() => Linking.openURL(termsUrl)}>QCS Terms &amp; Conditions</Text></Text>
        <Switch value={terms} onValueChange={setTerms} />
      </View>
      <Banner text={error} />
      <Button title="Done" onPress={save} busy={busy} />
    </Screen>
  );
}
