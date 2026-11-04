import { colors } from "@qcs/ui";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: colors.background }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ color: colors.primary }}>QCS Ghana</h1>
        <p style={{ color: colors.muted }}>Foundations ready. Screens come in later phases.</p>
      </div>
    </main>
  );
}
