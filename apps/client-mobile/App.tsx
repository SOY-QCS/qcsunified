import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "@qcs/ui";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>QCS</Text>
      <Text style={styles.sub}>Foundations ready. Screens come in later phases.</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700" },
  sub: { color: "#fff", marginTop: 8, textAlign: "center" },
});
