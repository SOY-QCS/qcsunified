import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, Field, Title, supabase } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { useAuth } from "../../lib/auth";
import { remitByMomo } from "../../lib/api";

interface Line { at: string; kind: string; amount: number; description: string; tracking_number: string | null; trip_id: string | null }
interface Cash { order_id: string; tracking_number: string; amount: number; collected_at: string; due_by: string; overdue: boolean }
interface Earnings {
  pay_basis: "fleet" | "commission"; balance: number; on_the_way: number; today: number; this_week: number; range_total: number;
  lines: Line[]; cash: Cash[]; cash_total: number; cod_blocked: boolean; momo_number: string | null; instant_fee: number; payout_weekday: number;
  payouts: { at: string; amount: number; fee: number; status: string; purpose: string; paid_at: string | null }[];
}
const ghs = (p: number) => `GHS ${(p / 100).toFixed(2)}`;
const time = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", weekday: "short", hour: "2-digit", minute: "2-digit" });
const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const KIND: Record<string, string> = { pickup: "Pickup", delivery: "Stop", commission: "Commission", bonus: "Bonus", deduction: "Deduction" };

/** My money: what I earned (today / this week, job by job), cash I'm holding for QCS, and payouts. */
export default function EarningsScreen() {
  const router = useRouter();
  const inset = useSafeAreaInsets();
  const { session } = useAuth();
  const [e, setE] = useState<Earnings | null>(null);
  const [tab, setTab] = useState<"today" | "week">("today");
  const [sel, setSel] = useState<string[]>([]);
  const [momo, setMomo] = useState("");
  const [cashout, setCashout] = useState("");
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase().rpc("my_earnings", {});
    if (error) return setMsg({ text: error.message, kind: "error" });
    setE(data as Earnings); setMomo((data as Earnings).momo_number ?? "");
  }, []);
  useEffect(() => { load(); }, [load]);

  // Group the lines by job so the rider sees "Trip: pickup + 3 stops = GHS …"
  const jobs = useMemo(() => {
    if (!e) return [];
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Accra" });
    const lines = e.lines.filter((l) => tab === "week" || new Date(l.at).toLocaleDateString("en-CA", { timeZone: "Africa/Accra" }) === today);
    const map = new Map<string, Line[]>();
    for (const l of lines) { const k = l.trip_id ?? `x-${l.at}`; map.set(k, [...(map.get(k) ?? []), l]); }
    return [...map.values()];
  }, [e, tab]);

  async function run(fn: () => Promise<void>) { setBusy(true); setMsg(null); try { await fn(); } catch (x) { setMsg({ text: (x as Error).message, kind: "error" }); } finally { setBusy(false); } }

  if (!e) return <View style={{ flex: 1, padding: 16, paddingTop: inset.top + 16 }}><Banner text={msg?.text ?? null} /><Text>Loading…</Text></View>;
  const selected = e.cash.filter((c) => sel.includes(c.order_id)).reduce((s, c) => s + c.amount, 0);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, paddingTop: inset.top + 16 }}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Title sub={e.pay_basis === "fleet" ? "QCS fleet: pickup fee + fee per delivered stop" : "Independent: commission on each delivery"}>My earnings</Title>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />

      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["today", "week"] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={{ flex: 1, backgroundColor: tab === t ? colors.primary : "#fff", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "#e6e1da" }}>
            <Text style={{ color: tab === t ? "#fff" : colors.muted }}>{t === "today" ? "Today" : "This week"}</Text>
            <Text style={{ color: tab === t ? "#fff" : colors.text, fontSize: 24, fontWeight: "900" }}>{ghs(t === "today" ? e.today : e.this_week)}</Text>
          </Pressable>
        ))}
      </View>

      {jobs.map((ls, i) => (
        <View key={i} style={{ backgroundColor: "#fff", borderRadius: 12, padding: 12, marginTop: 8, borderWidth: 1, borderColor: "#e6e1da" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontWeight: "800" }}>{ls[0]!.trip_id ? `Job · ${time(ls[ls.length - 1]!.at)}` : KIND[ls[0]!.kind] ?? ls[0]!.kind}</Text>
            <Text style={{ fontWeight: "800" }}>{ghs(ls.reduce((s, l) => s + l.amount, 0))}</Text>
          </View>
          {ls.map((l, j) => <Text key={j} style={{ color: l.amount < 0 ? colors.danger : colors.muted }}>{KIND[l.kind] ?? l.kind} · {l.tracking_number ?? l.description} · {ghs(l.amount)}</Text>)}
        </View>
      ))}
      {!jobs.length && <Text style={{ color: colors.muted, marginTop: 8 }}>No earnings {tab === "today" ? "today" : "this week"} yet.</Text>}

      {/* cash in hand */}
      <View style={{ backgroundColor: e.cash_total ? "#fbeee4" : "#fff", borderRadius: 14, padding: 14, marginTop: 16, borderWidth: 1, borderColor: e.cash.some((c) => c.overdue) ? colors.danger : "#e6e1da" }}>
        <Text style={{ fontSize: 17, fontWeight: "800" }}>Cash you're holding for QCS: {ghs(e.cash_total)}</Text>
        <Text style={{ color: colors.muted }}>Hand it all in by the end of the day.{e.cod_blocked ? " You get no cash jobs until you do." : ""}</Text>
        {e.cash.map((c) => (
          <Pressable key={c.order_id} onPress={() => setSel((s) => (s.includes(c.order_id) ? s.filter((x) => x !== c.order_id) : [...s, c.order_id]))}
            style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderColor: "#f0e3d6" }}>
            <Text>{sel.includes(c.order_id) ? "✅" : "⬜"} {c.tracking_number}{c.overdue ? "  ⚠ late" : ""}</Text>
            <Text style={{ fontWeight: "700" }}>{ghs(c.amount)}</Text>
          </Pressable>
        ))}
        {e.cash.length > 0 && <>
          <Button title={sel.length ? `Pay ${ghs(selected)} by MoMo` : "Select all and pay by MoMo"} busy={busy}
            onPress={() => run(async () => {
              const ids = sel.length ? sel : e.cash.map((c) => c.order_id);
              const r = await remitByMomo(ids);
              setMsg(r === "paid" ? { text: "Cash handed in ✓", kind: "success" } : r === "pending" ? { text: "Checking your payment… pull down to refresh in a minute.", kind: "info" } : { text: "Payment not completed. Nothing was taken.", kind: "error" });
              setSel([]); await load();
            })} />
          <Text style={{ color: colors.muted, marginTop: 6 }}>Or take the cash to your hub: the hub staff count it and record it, and it disappears from this list.</Text>
        </>}
      </View>

      {/* payouts */}
      <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 14, marginTop: 16, borderWidth: 1, borderColor: "#e6e1da" }}>
        <Text style={{ fontSize: 17, fontWeight: "800" }}>Ready to be paid: {ghs(e.balance)}</Text>
        <Text style={{ color: colors.muted }}>Paid every {DAYS[e.payout_weekday]} to your MoMo after Finance approves.{e.on_the_way ? ` ${ghs(e.on_the_way)} is on the way.` : ""}</Text>
        <Field label="My MoMo number for payouts" keyboardType="phone-pad" value={momo} onChangeText={setMomo} placeholder="024 123 4567" />
        {momo !== (e.momo_number ?? "") && <Button title="Save number" kind="secondary" busy={busy} onPress={() => run(async () => {
          const d = momo.replace(/\D/g, ""); const n = d.startsWith("233") ? `+${d}` : d.startsWith("0") ? `+233${d.slice(1)}` : null;
          if (!n || n.length !== 13) throw new Error("Enter a Ghana mobile number");
          const { error } = await supabase().from("riders").update({ payout_momo_number: n }).eq("id", session!.user.id);
          if (error) throw error;
          setMsg({ text: "Saved", kind: "success" }); await load();
        })} />}
        <Field label={`Cash out now (fee ${ghs(e.instant_fee)})`} keyboardType="decimal-pad" value={cashout} onChangeText={setCashout} placeholder="Amount in GHS" />
        <Button title="Request cash-out" busy={busy} disabled={!Number(cashout)} onPress={() => run(async () => {
          const { error } = await supabase().rpc("request_rider_cashout", { p_amount: Math.round(Number(cashout) * 100) });
          if (error) throw error;
          setCashout(""); setMsg({ text: "Requested. You'll get it once Finance approves.", kind: "success" }); await load();
        })} />
        {e.payouts.map((p, i) => (
          <Text key={i} style={{ color: colors.muted, marginTop: 4 }}>{time(p.at)} · {ghs(p.amount)}{p.fee ? ` (+${ghs(p.fee)} fee)` : ""} · {p.status === "paid" ? "paid ✓" : p.status}</Text>
        ))}
      </View>
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </ScrollView>
  );
}
