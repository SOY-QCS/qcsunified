import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";

type Prefs = { push: boolean; whatsapp: boolean; sms: boolean; email: boolean };
const ROWS: { key: keyof Prefs; label: string; hint: string }[] = [
  { key: "push", label: "App notifications", hint: "Free. Rider assigned, picked up, delivered." },
  { key: "whatsapp", label: "WhatsApp", hint: "Main updates with a tracking link." },
  { key: "sms", label: "SMS", hint: "For phones without data." },
  { key: "email", label: "Email", hint: "Delivery confirmations." },
];

/** How I want to hear about my deliveries. Delivery codes and price changes are always sent. */
export default function Settings() {
  const router = useRouter();
  const { session } = useAuth();
  const me = session!.user.id;
  const [prefs, setPrefs] = useState<Prefs>({ push: true, whatsapp: true, sms: false, email: false });
  const [marketing, setMarketing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" } | null>(null);

  useEffect(() => {
    supabase().from("notification_preferences").select("push, whatsapp, sms, email").eq("user_id", me).maybeSingle()
      .then(({ data }) => { if (data) setPrefs(data); });
    supabase().from("profiles").select("marketing_opt_in").eq("id", me).single().then(({ data }) => setMarketing(!!data?.marketing_opt_in));
  }, [me]);

  async function save() {
    const a = await supabase().from("notification_preferences").upsert({ user_id: me, ...prefs, updated_at: new Date().toISOString() });
    const b = await supabase().from("profiles").update({ marketing_opt_in: marketing }).eq("id", me);
    setMsg(a.error || b.error ? { text: (a.error ?? b.error)!.message, kind: "error" } : { text: "Saved", kind: "success" });
  }

  return (
    <Screen>
      <Title sub="Delivery codes and price changes are always sent.">Notifications</Title>
      {ROWS.map((r) => (
        <View key={r.key} style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#e6e1da" }}>
          <View style={{ flex: 1 }}><Text style={{ fontWeight: "700" }}>{r.label}</Text><Text style={{ color: colors.muted }}>{r.hint}</Text></View>
          <Switch value={prefs[r.key]} onValueChange={(v) => setPrefs({ ...prefs, [r.key]: v })} />
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#e6e1da" }}>
        <View style={{ flex: 1 }}><Text style={{ fontWeight: "700" }}>Offers and news</Text><Text style={{ color: colors.muted }}>Promotions from QCS. You can stop any time.</Text></View>
        <Switch value={marketing} onValueChange={setMarketing} />
      </View>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />
      <Button title="Save" onPress={save} />
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
