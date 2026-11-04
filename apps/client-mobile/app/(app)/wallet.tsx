import { useCallback, useEffect, useState } from "react";
import { Share, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Choice, Field, Screen, Title } from "@qcs/mobile";
import { colors } from "@qcs/ui";
import { api, ghs } from "../../lib/api";
import { payWithHubtel } from "../../lib/pay";

interface Wallet { cash: number; credit: number; referral_code: string; can_withdraw_to: string | null; entries: { at: string; amount: number; wallet: string; description: string }[] }

export default function WalletScreen() {
  const router = useRouter();
  const [w, setW] = useState<Wallet | null>(null);
  const [topup, setTopup] = useState("50");
  const [withdraw, setWithdraw] = useState("");
  const [msg, setMsg] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api<Wallet>("/api/v1/wallet").then(setW).catch((e) => setMsg({ text: e.message, kind: "error" })), []);
  useEffect(() => { load(); }, [load]);

  async function doTopup() {
    setBusy("topup"); setMsg(null);
    try {
      const r = await payWithHubtel({ purpose: "wallet_topup", amount: Math.round(Number(topup) * 100) });
      setMsg(r === "paid" ? { text: "Top-up received ✓", kind: "success" } : r === "pending" ? { text: "Waiting for Hubtel to confirm — your balance updates in a moment.", kind: "info" } : { text: "Top-up didn't go through. Nothing was taken.", kind: "error" });
      await load();
    } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  }

  async function doWithdraw() {
    setBusy("withdraw"); setMsg(null);
    try {
      const r = await api<{ momo_number: string }>("/api/v1/wallet/withdraw", { method: "POST", body: JSON.stringify({ amount: Math.round(Number(withdraw) * 100) }) });
      setMsg({ text: `Withdrawal requested to ${r.momo_number}. QCS Finance approves it, then Hubtel sends the money.`, kind: "success" });
      setWithdraw(""); await load();
    } catch (e) { setMsg({ text: (e as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  }

  return (
    <Screen>
      <Title sub="Pay for deliveries straight from your wallet">QCS wallet</Title>
      <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, backgroundColor: "#fff", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#e6e1da" }}>
          <Text style={{ color: colors.muted }}>Balance</Text><Text style={{ fontSize: 24, fontWeight: "800" }}>{ghs(w?.cash ?? 0)}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: "#fbeee4", borderRadius: 12, padding: 14 }}>
          <Text style={{ color: colors.muted }}>Promo credit</Text><Text style={{ fontSize: 24, fontWeight: "800" }}>{ghs(w?.credit ?? 0)}</Text>
          <Text style={{ color: colors.muted, fontSize: 11 }}>Used first · can&apos;t be withdrawn</Text>
        </View>
      </View>
      <Banner text={msg?.text ?? null} kind={msg?.kind} />

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 8 }}>Top up</Text>
      <Choice label="Amount (GHS)" value={topup} onChange={setTopup} options={["20", "50", "100", "200"].map((v) => ({ value: v, label: `GHS ${v}` }))} />
      <Field label="Or type an amount (GHS)" keyboardType="decimal-pad" value={topup} onChangeText={setTopup} />
      <Button title="Top up with MoMo or card" onPress={doTopup} busy={busy === "topup"} />

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 20 }}>Withdraw</Text>
      <Text style={{ color: colors.muted, marginBottom: 8 }}>{w?.can_withdraw_to ? `Money goes back to ${w.can_withdraw_to} — the MoMo number you topped up with.` : "Withdrawals go back to the MoMo number you top up with. Top up by MoMo first."}</Text>
      {w?.can_withdraw_to && <>
        <Field label="Amount (GHS)" keyboardType="decimal-pad" value={withdraw} onChangeText={setWithdraw} />
        <Button title="Request withdrawal" kind="secondary" onPress={doWithdraw} busy={busy === "withdraw"} disabled={!withdraw} />
      </>}

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 20 }}>Invite friends</Text>
      <Text style={{ color: colors.muted }}>When a friend uses your code and gets their first delivery, you both get promo credit.</Text>
      <Text style={{ fontSize: 26, fontWeight: "900", letterSpacing: 2, marginVertical: 8 }}>{w?.referral_code ?? "…"}</Text>
      <Button title="Share my code" kind="secondary" onPress={() => w && Share.share({ message: `Send parcels across Ghana with QCS. Use my code ${w.referral_code} when you sign up and get delivery credit.` })} />

      <Text style={{ fontWeight: "800", fontSize: 18, marginTop: 20, marginBottom: 6 }}>Activity</Text>
      {(w?.entries ?? []).map((e, i) => (
        <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderColor: "#efe9e2" }}>
          <View style={{ flex: 1 }}><Text>{e.description}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{new Date(e.at).toLocaleString("en-GB")}{e.wallet === "customer_credit" ? " · credit" : ""}</Text></View>
          <Text style={{ color: e.amount < 0 ? colors.danger : colors.success, fontWeight: "700" }}>{e.amount > 0 ? "+" : ""}{ghs(e.amount)}</Text>
        </View>
      ))}
      {w && w.entries.length === 0 && <Text style={{ color: colors.muted }}>No activity yet.</Text>}
      <Button title="Back" kind="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
