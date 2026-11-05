import Link from "next/link";
import { helpSections, type HelpArticle } from "@qcs/types";
import { supabaseServer } from "@/lib/supabase/server";

/** Help centre for vendors. Articles are written by QCS Support in the Ops dashboard. */
export default async function HelpPage() {
  const { data } = await (await supabaseServer()).from("help_articles").select("id, slug, audience, category, title, body, sort").eq("published", true);
  const sections = helpSections((data ?? []) as HelpArticle[], "vendor");
  return (
    <>
      <h1>Help centre</h1>
      <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: 1 }}>Can&apos;t find your answer? We reply within 1 working hour (Mon–Sat, 8am–6pm).</span>
        <Link className="btn" href="/support?new=1">Contact support</Link>
        <Link className="btn secondary" href="/support">My tickets</Link>
      </div>
      {sections.map((s) => (
        <section key={s.category}>
          <h2>{s.category}</h2>
          <ul>{s.articles.map((a) => <li key={a.id}><Link href={`/help/${a.slug}`}>{a.title}</Link></li>)}</ul>
        </section>
      ))}
    </>
  );
}
