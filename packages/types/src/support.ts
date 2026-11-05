/**
 * Support & help centre, shared by the client app, rider app, vendor portal and website.
 * The categories must match open_ticket() in supabase/migrations (the database refuses others).
 */
export type Asker = "client" | "vendor" | "rider";

export const PROBLEMS: { value: string; label: string; who: Asker[]; urgent?: boolean }[] = [
  { value: "delay", label: "It's late / where is my parcel?", who: ["client", "vendor"] },
  { value: "damaged", label: "Parcel arrived damaged", who: ["client", "vendor"], urgent: true },
  { value: "missing", label: "Parcel missing or not received", who: ["client", "vendor"], urgent: true },
  { value: "cod_money", label: "Cash on delivery (COD) money", who: ["vendor", "rider"], urgent: true },
  { value: "rider", label: "Problem with the rider", who: ["client", "vendor"] },
  { value: "address", label: "Wrong address / can't find the place", who: ["client", "vendor", "rider"] },
  { value: "billing", label: "Charged wrongly / refund", who: ["client", "vendor"] },
  { value: "payout", label: "My earnings or payout", who: ["rider"] },
  { value: "account", label: "My account", who: ["client", "vendor", "rider"] },
  { value: "app", label: "The app isn't working", who: ["client", "vendor", "rider"] },
  { value: "other", label: "Something else", who: ["client", "vendor", "rider"] },
];
export const problemsFor = (who: Asker, withOrder: boolean) =>
  PROBLEMS.filter((p) => p.who.includes(who) && (withOrder || !["delay", "damaged", "missing", "rider"].includes(p.value)));
export const problemLabel = (v: string) => PROBLEMS.find((p) => p.value === v)?.label ?? v;

export const TICKET_STATUS_TEXT: Record<string, string> = {
  open: "With QCS support", pending: "Waiting for your answer", resolved: "Solved", closed: "Closed",
};

/** Help articles are plain text: blank line = new paragraph, "- " = bullet. */
export type HelpBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] };
export function helpBlocks(body: string): HelpBlock[] {
  const out: HelpBlock[] = [];
  for (const chunk of body.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    let para: string[] = [];
    const flush = () => { if (para.length) out.push({ kind: "p", text: para.join(" ") }); para = []; };
    for (const l of lines) {
      if (l.startsWith("- ")) {
        flush();
        const last = out[out.length - 1];
        if (last?.kind === "ul") last.items.push(l.slice(2)); else out.push({ kind: "ul", items: [l.slice(2)] });
      } else para.push(l);
    }
    flush();
  }
  return out;
}

export interface HelpArticle { id: string; slug: string; audience: "all" | Asker; category: string; title: string; body: string; sort: number }
/** Articles for one audience, grouped by section in their configured order. */
export function helpSections(articles: HelpArticle[], who: Asker | "public"): { category: string; articles: HelpArticle[] }[] {
  const list = articles.filter((a) => a.audience === "all" || a.audience === who || (who === "public" && a.audience !== "rider")).sort((a, b) => a.sort - b.sort);
  const map = new Map<string, HelpArticle[]>();
  for (const a of list) map.set(a.category, [...(map.get(a.category) ?? []), a]);
  return [...map.entries()].map(([category, articles]) => ({ category, articles }));
}
