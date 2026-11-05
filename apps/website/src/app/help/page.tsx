import Link from "next/link";
import { helpSections, type HelpArticle } from "@qcs/types";
import { API, Shell } from "../shell";

export const metadata = { title: "Help centre · QCS Ghana", description: "Answers about booking, prices, delivery codes, COD, inter-city and claims." };
export const revalidate = 300;

async function articles(): Promise<HelpArticle[]> {
  try { return ((await (await fetch(`${API}/api/v1/help`, { next: { revalidate: 300 } })).json()) as { articles?: HelpArticle[] }).articles ?? []; }
  catch { return []; }
}

export default async function Help() {
  const sections = helpSections(await articles(), "public");
  return (
    <Shell>
      <h1>Help centre</h1>
      {sections.map((s) => (
        <section key={s.category}><h2 style={{ fontSize: 17 }}>{s.category}</h2>
          <ul>{s.articles.map((a) => <li key={a.slug} style={{ margin: "6px 0" }}><Link href={`/help/${a.slug}`}>{a.title}</Link></li>)}</ul></section>
      ))}
      {!sections.length && <p>Help is not available right now. Please message us on WhatsApp.</p>}
      <p style={{ marginTop: 24 }}>Need a person? In the QCS app tap <strong>Report a problem</strong> on your delivery, or message us on WhatsApp. We reply within 1 working hour (Mon–Sat, 8am–6pm).</p>
    </Shell>
  );
}
