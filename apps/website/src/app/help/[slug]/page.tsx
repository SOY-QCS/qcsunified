import Link from "next/link";
import { notFound } from "next/navigation";
import { helpBlocks } from "@qcs/types";
import { API, Shell } from "../../shell";

export const revalidate = 300;

async function article(slug: string): Promise<{ title: string; body: string; category: string } | null> {
  try { const r = await fetch(`${API}/api/v1/help/${encodeURIComponent(slug)}`, { next: { revalidate: 300 } }); return r.ok ? await r.json() : null; }
  catch { return null; }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const a = await article((await params).slug);
  return { title: a ? `${a.title} · QCS Help` : "QCS Help" };
}

export default async function HelpArticle({ params }: { params: Promise<{ slug: string }> }) {
  const a = await article((await params).slug);
  if (!a) notFound();
  return (
    <Shell>
      <p><Link href="/help">← Help centre</Link> · {a.category}</p>
      <h1 style={{ fontSize: 22 }}>{a.title}</h1>
      {helpBlocks(a.body).map((b, i) => (b.kind === "p" ? <p key={i}>{b.text}</p> : <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>))}
    </Shell>
  );
}
