import { useState } from "react";
import { Text } from "react-native";
import { normalizeGhanaPhone } from "@qcs/types";
import { colors } from "@qcs/ui";
import { Banner, Button, Field, Screen, Title } from "./kit";
import { friendlyError, supabase } from "./supabase";

/**
 * Phone number + SMS code login (the code is sent by Hubtel through our Supabase hook).
 * New numbers are signed up automatically; the app then asks for their details.
 */
export function PhoneLogin({ appName, tagline }: { appName: string; tagline: string }) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [raw, setRaw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = normalizeGhanaPhone(raw);

  async function sendCode() {
    setError(null);
    if (!phone) return setError("Enter your Ghana phone number, e.g. 024 123 4567");
    setBusy(true);
    const { error } = await supabase().auth.signInWithOtp({ phone });
    setBusy(false);
    if (error) return setError(friendlyError(error.message));
    setStep("code");
  }

  async function verify() {
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code from the SMS");
    setBusy(true);
    const { error } = await supabase().auth.verifyOtp({ phone: phone!, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) setError(friendlyError(error.message));
    // On success the app's auth listener moves on to the next screen.
  }

  return (
    <Screen>
      <Text style={{ fontSize: 40, fontWeight: "900", color: colors.primary, marginTop: 24 }}>QCS</Text>
      {step === "phone" ? (
        <>
          <Title sub={tagline}>{appName}</Title>
          <Field label="Phone number" keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber"
            placeholder="024 123 4567" value={raw} onChangeText={setRaw} onSubmitEditing={sendCode} />
          <Banner text={error} />
          <Button title="Send me a code" onPress={sendCode} busy={busy} />
          <Text style={{ color: colors.muted, marginTop: 16, fontSize: 12 }}>
            We'll text you a 6-digit code to confirm it's you.
          </Text>
        </>
      ) : (
        <>
          <Title sub={`We sent a code to ${phone}`}>Enter your code</Title>
          <Field label="6-digit code" keyboardType="number-pad" autoComplete="sms-otp" textContentType="oneTimeCode"
            maxLength={6} value={code} onChangeText={setCode} onSubmitEditing={verify} autoFocus />
          <Banner text={error} />
          <Button title="Continue" onPress={verify} busy={busy} />
          <Button title="Send a new code" kind="secondary" onPress={sendCode} disabled={busy} />
          <Button title="Change number" kind="secondary" onPress={() => { setStep("phone"); setCode(""); setError(null); }} />
        </>
      )}
    </Screen>
  );
}
