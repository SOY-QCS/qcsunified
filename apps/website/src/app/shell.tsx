import { colors } from "@qcs/ui";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
export const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

/** Simple page frame for the public pages (phone-first). */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header style={{ background: colors.primary, color: "#fff", padding: "12px 16px" }}>
        <a href="/" style={{ color: "#fff", textDecoration: "none", fontWeight: 900, fontSize: 18 }}>QCS Ghana</a>
      </header>
      <main style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>{children}</main>
      <footer style={{ maxWidth: 640, margin: "24px auto 0", padding: "12px 16px 32px", fontSize: 13, color: "#6b6b6b", display: "flex", gap: 16, flexWrap: "wrap" }}>
        <a href="/help" style={{ color: "inherit" }}>Help</a>
        <a href="/privacy" style={{ color: "inherit" }}>Privacy</a>
        <a href="/delete-account" style={{ color: "inherit" }}>Delete your account</a>
      </footer>
    </>
  );
}
