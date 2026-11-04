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
    </>
  );
}
