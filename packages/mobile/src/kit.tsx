import type { ReactNode } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, spacing } from "@qcs/ui";

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const body = <View style={s.body}>{children}</View>;
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>{body}</ScrollView> : body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={s.title}>{children}</Text>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
    </View>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={s.input} {...props} />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, busy, disabled, kind = "primary" }: {
  title: string; onPress: () => void; busy?: boolean; disabled?: boolean; kind?: "primary" | "secondary" | "danger";
}) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.btn, kind !== "primary" && s.btnSecondary, kind === "danger" && { borderColor: colors.danger }, (pressed || off) && { opacity: 0.7 }]}>
      {busy ? <ActivityIndicator color={kind === "primary" ? "#fff" : colors.primary} /> :
        <Text style={[s.btnText, kind !== "primary" && { color: kind === "danger" ? colors.danger : colors.text }]}>{title}</Text>}
    </Pressable>
  );
}

/** A row of choices (e.g. vehicle type, MoMo network). */
export function Choice<T extends string>({ label, options, value, onChange }: {
  label: string; options: readonly { value: T; label: string }[]; value: T | null; onChange: (v: T) => void;
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={s.label}>{label}</Text>
      <View style={s.chips}>
        {options.map((o) => (
          <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.chip, value === o.value && s.chipOn]} accessibilityState={{ selected: value === o.value }}>
            <Text style={[s.chipText, value === o.value && { color: colors.primaryDark, fontWeight: "700" }]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Banner({ text, kind = "error" }: { text: string | null; kind?: "error" | "info" | "success" }) {
  if (!text) return null;
  const bg = kind === "error" ? "#fdecea" : kind === "success" ? "#eaf6ee" : "#fbeee4";
  const fg = kind === "error" ? colors.danger : kind === "success" ? colors.success : colors.primaryDark;
  return <View style={[s.banner, { backgroundColor: bg }]}><Text style={{ color: fg }}>{text}</Text></View>;
}

export const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1, padding: spacing.lg },
  title: { fontSize: 26, fontWeight: "800", color: colors.text },
  sub: { fontSize: 15, color: colors.muted, marginTop: 6 },
  label: { fontWeight: "600", marginBottom: 6, color: colors.text },
  hint: { color: colors.muted, fontSize: 12, marginTop: 4 },
  input: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e6e1da", borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: colors.text },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 15, alignItems: "center", marginTop: spacing.sm, borderWidth: 1, borderColor: colors.primary },
  btnSecondary: { backgroundColor: "#fff", borderColor: "#e6e1da" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#e6e1da", backgroundColor: "#fff", borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  chipOn: { borderColor: colors.primary, backgroundColor: "#fbeee4" },
  chipText: { color: colors.text },
  banner: { borderRadius: radius.md, padding: 12, marginVertical: spacing.sm },
});
