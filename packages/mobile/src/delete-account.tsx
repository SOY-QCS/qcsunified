/**
 * "Delete my account" (required by Google Play and the App Store).
 * Sends a request; QCS support checks nothing is owed either way and deletes the account within 30 days.
 * Order and payment history is kept without personal details (business and tax records).
 */
import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { colors } from "@qcs/ui";
import { Banner, Button, Field, s } from "./kit";
import { supabase } from "./supabase";

type Request = { id: string; status: string; requested_at: string; blockers: string[] } | null;

export function DeleteAccount() {
  const [req, setReq] = useState<Request>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { supabase().rpc("my_account_deletion").then(({ data }) => setReq((data as Request) ?? null)); }, []);

  const send = () => Alert.alert("Delete your account?", "QCS will erase your name, phone number, email and saved addresses within 30 days, and you won't be able to sign in. Past deliveries stay in our records without your details.", [
    { text: "Keep my account", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: async () => {
      setBusy(true); setErr(null);
      const { data, error } = await supabase().rpc("request_account_deletion", { p_reason: reason || null });
      setBusy(false);
      if (error) setErr(error.message); else { setReq(data as Request); setOpen(false); }
    } },
  ]);
  const cancel = async () => { setBusy(true); await supabase().rpc("cancel_account_deletion"); setBusy(false); setReq(null); };

  return (
    <View style={{ marginTop: 24, gap: 8 }}>
      <Text style={[s.label, { color: colors.muted }]}>Your account</Text>
      {req ? (
        <>
          <Banner kind="info" text={`You asked to delete your account on ${new Date(req.requested_at).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}. QCS support will finish it within 30 days.`} />
          {req.blockers.length > 0 && <Banner kind="error" text={`Before we can delete it:\n• ${req.blockers.join("\n• ")}`} />}
          <Button title="Keep my account" kind="secondary" busy={busy} onPress={cancel} />
        </>
      ) : open ? (
        <>
          <Field label="Why are you leaving? (optional)" value={reason} onChangeText={setReason} placeholder="It helps us improve" />
          <Banner text={err} />
          <Button title="Delete my account" kind="danger" busy={busy} onPress={send} />
          <Button title="Never mind" kind="secondary" onPress={() => setOpen(false)} />
        </>
      ) : (
        <Button title="Delete my account" kind="danger" onPress={() => setOpen(true)} />
      )}
    </View>
  );
}
