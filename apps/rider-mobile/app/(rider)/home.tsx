import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Screen, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import type { Queue } from "@qcs/types";
import { useAuth } from "../../lib/auth";
import { useJob, useOffer } from "../../lib/job";
import { startTracking, stopTracking } from "../../lib/location";
import { onQueue } from "../../lib/queue";
import { OfferCard } from "../../components/offer-card";

export default function Home() {
  const router = useRouter();
  const { session, account } = useAuth();
  const me = session!.user.id;
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState<Queue | null>(null);
  const { job, refresh: refreshJob } = useJob();
  const { offer, refresh: refreshOffer } = useOffer(me, online && !job);

  useEffect(() => onQueue(setQ), []);
  useEffect(() => {
    supabase().from("riders").select("is_online, score, offers_received, offers_accepted, cod_float_balance").eq("id", me).single()
      .then(({ data }) => setOnline(!!data?.is_online));
  }, [me]);
  useEffect(() => { if (job) router.push("/job"); }, [job, router]);

  async function toggle(v: boolean) {
    setError(null); setBusy(true);
    try {
      if (v) { const problem = await startTracking(false); if (problem) throw new Error(problem); }
      const { error } = await supabase().from("riders").update({ is_online: v }).eq("id", me);
      if (error) throw error;
      if (!v) await stopTracking();
      setOnline(v);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function answer(accept: boolean) {
    if (!offer) return;
    setBusy(true); setError(null);
    const { data, error } = await supabase().rpc("respond_offer", { p_offer: offer.id, p_accept: accept });
    setBusy(false);
    if (error) return setError(error.message);
    if (data === "expired") setError("Too late — the offer went to another rider.");
    if (data === "accepted") { await startTracking(true); await refreshJob(); }
    refreshOffer();
  }

  return (
    <Screen>
      <Title sub={account?.rider?.rider_type === "fleet" ? "QCS fleet rider" : "Independent rider"}>Hi {(account?.profile?.full_name ?? "").split(" ")[0]}</Title>
      <View style={{ backgroundColor: online ? "#eaf6ee" : "#fff", borderRadius: 14, padding: 18, borderWidth: 1, borderColor: "#e6e1da", flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: "800" }}>{online ? "You're online" : "You're offline"}</Text>
          <Text style={{ color: colors.muted }}>{online ? "New jobs near you will pop up here." : "Go online to receive jobs."}</Text>
        </View>
        <Switch value={online} onValueChange={toggle} disabled={busy} />
      </View>
      <Banner text={error} />
      {q && q.items.length > 0 && <Banner kind="info" text={`${q.items.length} update(s) waiting for signal — they'll send automatically.`} />}
      {offer && <OfferCard offer={offer} onAnswer={answer} busy={busy} />}
      {job && <Button title="Open my current job" onPress={() => router.push("/job")} />}
      {online && !offer && !job && <Text style={{ color: colors.muted, marginTop: 16, textAlign: "center" }}>Waiting for a job…</Text>}
      <View style={{ flex: 1 }} />
      <Button title="Sign out" kind="secondary" onPress={async () => { if (online) await toggle(false); await supabase().auth.signOut(); }} />
    </Screen>
  );
}
