import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { HelpBody } from "@/components/help";

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { data: a } = await (await supabaseServer()).from("help_articles").select("title, body, category").eq("slug", slug).eq("published", true).maybeSingle();
  if (!a) notFound();
  return (
    <>
      <p><Link href="/help">← Help centre</Link> · {a.category}</p>
      <h1>{a.title}</h1>
      <div className="card" style={{ maxWidth: 720 }}><HelpBody body={a.body} /></div>
      <p>Still stuck? <Link href="/support?new=1">Contact support</Link></p>
    </>
  );
}
