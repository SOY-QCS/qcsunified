import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { has, when } from "@/lib/ops";
import { CRM_ROLES, CrmTabs } from "../tabs";
import { ArticleForm, CannedForm, DeleteCanned } from "./forms";

/** Help centre articles (shown in the apps, the portal and on the website) and support's canned replies. */
export default async function Help({ searchParams }: PageProps<"/crm/help">) {
  const me = await requireRole([...CRM_ROLES]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [{ data: articles }, { data: canned }] = await Promise.all([
    sb.from("help_articles").select("*").order("sort"),
    sb.from("canned_replies").select("id, title, body, category").order("title"),
  ]);
  const edit = typeof sp.edit === "string" ? sp.edit : null;
  const current = edit && edit !== "new" ? (articles ?? []).find((a) => a.id === edit) : null;
  const canEdit = has(me, "super_admin", "support");
  return (
    <>
      <h1>Help centre</h1>
      <CrmTabs at="/crm/help" />
      <p className="muted">Articles appear in the client app, the rider app, the vendor portal and on the website. Plain text: leave a blank line between paragraphs; start a line with &quot;- &quot; for a bullet.</p>
      {canEdit && (edit ? <div className="card" style={{ maxWidth: 760 }}>
        <strong>{current ? `Edit: ${current.title}` : "New article"}</strong>
        <ArticleForm v={current ? { id: current.id, slug: current.slug, audience: current.audience as "all" | "client" | "vendor" | "rider", category: current.category, title: current.title, body: current.body, sort: current.sort, published: current.published }
          : { id: null, slug: "", audience: "all", category: "", title: "", body: "", sort: 200, published: true }} />
        <p><Link href="/crm/help">Close</Link></p>
      </div> : <p><Link className="btn small" href="/crm/help?edit=new">+ New article</Link></p>)}
      <table>
        <thead><tr><th>Article</th><th>For</th><th>Section</th><th>Status</th><th>Updated</th></tr></thead>
        <tbody>{(articles ?? []).map((a) => (
          <tr key={a.id}><td>{canEdit ? <Link href={`/crm/help?edit=${a.id}`}>{a.title}</Link> : a.title}<div className="muted">/help/{a.slug}</div></td>
            <td>{a.audience}</td><td>{a.category}</td><td>{a.published ? "published" : <span className="sla warn">draft</span>}</td><td>{when(a.updated_at)}</td></tr>))}</tbody>
      </table>

      <h2>Canned replies</h2>
      <p className="muted">Short answers agents can drop into a ticket reply.</p>
      <table><tbody>{(canned ?? []).map((c) => (
        <tr key={c.id}><td><strong>{c.title}</strong>{c.category && <span className="tag" style={{ marginLeft: 6 }}>{c.category}</span>}<div>{c.body}</div></td>
          <td>{has(me, "super_admin", "city_admin", "support") && <DeleteCanned id={c.id} />}</td></tr>))}</tbody></table>
      {has(me, "super_admin", "city_admin", "support") && <div className="card" style={{ maxWidth: 640 }}><strong>New canned reply</strong><CannedForm /></div>}
    </>
  );
}
