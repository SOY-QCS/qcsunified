import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { colors, radius, spacing } from "@qcs/ui";
import { helpBlocks, helpSections, problemLabel, problemsFor, TICKET_STATUS_TEXT, type Asker, type HelpArticle } from "@qcs/types";
import { Banner, Button, Choice, Field, s } from "./kit";
import { supabase } from "./supabase";
import { pickPhoto, type PickedPhoto } from "./upload";

/**
 * Help centre + support for the client app and the rider app (the vendor portal and website have web versions).
 * Everything goes through the database functions open_ticket / reply_ticket, which check the person may do it.
 */

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Photos go to the person's own folder in the private "support" bucket. */
async function uploadSupportPhoto(photo: PickedPhoto): Promise<string> {
  const { data } = await supabase().auth.getUser();
  if (!data.user) throw new Error("Please sign in again");
  const path = `${data.user.id}/${Date.now()}.jpg`;
  const body = await (await fetch(photo.uri)).arrayBuffer();
  const { error } = await supabase().storage.from("support").upload(path, body, { contentType: "image/jpeg" });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  return path;
}

function Row({ title, sub, onPress }: { title: string; sub?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [{ backgroundColor: "#fff", borderRadius: radius.md, borderWidth: 1, borderColor: "#e6e1da", padding: 14, marginBottom: 8 }, pressed && { opacity: 0.7 }]}>
      <Text style={{ fontWeight: "600", color: colors.text }}>{title}</Text>
      {sub ? <Text style={{ color: colors.muted, marginTop: 2 }}>{sub}</Text> : null}
    </Pressable>
  );
}

export function HelpCentre({ who, onArticle, onContact, onTickets }: { who: Asker; onArticle: (slug: string) => void; onContact: () => void; onTickets: () => void }) {
  const [list, setList] = useState<HelpArticle[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    supabase().from("help_articles").select("id, slug, audience, category, title, body, sort").eq("published", true)
      .then(({ data, error }) => { if (error) setErr("Couldn't load help. Check your connection."); setList((data ?? []) as HelpArticle[]); });
  }, []);
  return (
    <View>
      <Button title="Contact support" onPress={onContact} />
      <Button title="My tickets" kind="secondary" onPress={onTickets} />
      <Text style={[s.hint, { marginBottom: spacing.md }]}>We reply within 1 working hour (Mon–Sat, 8am–6pm).</Text>
      <Banner text={err} />
      {list === null ? <ActivityIndicator color={colors.primary} /> : helpSections(list, who).map((sec) => (
        <View key={sec.category} style={{ marginBottom: spacing.md }}>
          <Text style={[s.label, { fontSize: 17 }]}>{sec.category}</Text>
          {sec.articles.map((a) => <Row key={a.slug} title={a.title} onPress={() => onArticle(a.slug)} />)}
        </View>
      ))}
    </View>
  );
}

export function HelpArticleView({ slug }: { slug: string }) {
  const [a, setA] = useState<{ title: string; body: string } | null | undefined>(undefined);
  useEffect(() => { supabase().from("help_articles").select("title, body").eq("slug", slug).maybeSingle().then(({ data }) => setA(data)); }, [slug]);
  if (a === undefined) return <ActivityIndicator color={colors.primary} />;
  if (!a) return <Banner text="This article is no longer available." />;
  return (
    <View>
      <Text style={s.title}>{a.title}</Text>
      {helpBlocks(a.body).map((b, i) => b.kind === "p"
        ? <Text key={i} style={{ fontSize: 16, lineHeight: 23, marginTop: spacing.md, color: colors.text }}>{b.text}</Text>
        : <View key={i} style={{ marginTop: spacing.sm }}>{b.items.map((x, j) => <Text key={j} style={{ fontSize: 16, lineHeight: 23, color: colors.text }}>•  {x}</Text>)}</View>)}
    </View>
  );
}

/** "Report a problem" (with a tracking number) or "Contact support" (without). */
export function ReportProblem({ who, tracking, onDone }: { who: Asker; tracking?: string; onDone: (ticketId: string, message: string) => void }) {
  const [cat, setCat] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const choices = problemsFor(who, !!tracking);
  const urgent = choices.find((c) => c.value === cat)?.urgent;
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const path = photo ? await uploadSupportPhoto(photo) : null;
      const { data, error } = await supabase().rpc("open_ticket", { p_category: cat, p_body: text, p_tracking: tracking ?? null, p_subject: null, p_attachment: path });
      if (error) throw new Error(error.message);
      const r = data as { id: string; number: number; existing: boolean };
      onDone(r.id, r.existing ? `Added to your open ticket #${r.number}.` : `Ticket #${r.number} sent. We'll reply in the app.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <View>
      <Choice label="What is it about?" options={choices.map((c) => ({ value: c.value, label: c.label }))} value={cat} onChange={setCat} />
      {urgent && <Banner kind="info" text="This is treated as top priority. A photo helps us settle it faster." />}
      <Field label="Tell us what happened" value={text} onChangeText={setText} multiline numberOfLines={4} style={[s.input, { minHeight: 100, textAlignVertical: "top" }]} />
      {photo ? <View style={{ marginBottom: spacing.md }}><Image source={{ uri: photo.uri }} style={{ width: 120, height: 120, borderRadius: 8 }} /><Button title="Remove photo" kind="secondary" onPress={() => setPhoto(null)} /></View>
        : <Button title="Add a photo (optional)" kind="secondary" onPress={() => pickPhoto("camera").then(setPhoto).catch((e: Error) => setErr(e.message))} />}
      <Banner text={err} />
      <Button title="Send" busy={busy} disabled={!cat || text.trim().length < 5} onPress={send} />
    </View>
  );
}

type T = { id: string; number: number; subject: string; category: string; status: string; updated_at: string; orders: { tracking_number: string } | { tracking_number: string }[] | null };

export function MyTickets({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<T[] | null>(null);
  useEffect(() => {
    supabase().from("tickets").select("id, number, subject, category, status, updated_at, orders(tracking_number)").order("updated_at", { ascending: false }).limit(50)
      .then(({ data }) => setList((data ?? []) as T[]));
  }, []);
  if (list === null) return <ActivityIndicator color={colors.primary} />;
  if (!list.length) return <Text style={s.sub}>You haven&apos;t contacted support yet.</Text>;
  return <View>{list.map((t) => {
    const o = Array.isArray(t.orders) ? t.orders[0] : t.orders;
    return <Row key={t.id} title={`#${t.number} ${t.subject}`} sub={`${TICKET_STATUS_TEXT[t.status] ?? t.status} · ${problemLabel(t.category)}${o ? ` · ${o.tracking_number}` : ""}`} onPress={() => onOpen(t.id)} />;
  })}</View>;
}

type M = { id: number; body: string; author_kind: string; attachment_path: string | null; created_at: string };

export function TicketThread({ id }: { id: string }) {
  const [t, setT] = useState<{ number: number; subject: string; status: string } | null>(null);
  const [msgs, setMsgs] = useState<M[]>([]);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase().from("tickets").select("number, subject, status").eq("id", id).maybeSingle(),
      supabase().from("ticket_messages").select("id, body, author_kind, attachment_path, created_at").eq("ticket_id", id).order("created_at"),
    ]);
    setT(a.data); setMsgs((b.data ?? []) as M[]);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const path = photo ? await uploadSupportPhoto(photo) : null;
      const { error } = await supabase().rpc("reply_ticket", { p_ticket: id, p_body: text, p_internal: false, p_attachment: path, p_resolve: false });
      if (error) throw new Error(error.message);
      setText(""); setPhoto(null); await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!t) return <ActivityIndicator color={colors.primary} />;
  return (
    <View>
      <Text style={s.title}>#{t.number}</Text>
      <Text style={s.sub}>{t.subject} · {TICKET_STATUS_TEXT[t.status] ?? t.status}</Text>
      <View style={{ marginTop: spacing.md, gap: 8 }}>
        {msgs.map((m) => (
          <View key={m.id} style={{ alignSelf: m.author_kind === "staff" ? "flex-start" : "flex-end", maxWidth: "88%", backgroundColor: m.author_kind === "staff" ? "#fbeee4" : "#fff",
            borderWidth: 1, borderColor: "#e6e1da", borderRadius: 12, padding: 10 }}>
            <Text style={{ color: colors.muted, fontSize: 12 }}>{m.author_kind === "staff" ? "QCS Support" : "You"} · {when(m.created_at)}</Text>
            <Text style={{ color: colors.text, fontSize: 15, marginTop: 2 }}>{m.body}</Text>
            {m.attachment_path ? <Text style={{ color: colors.muted, fontSize: 12 }}>📎 photo attached</Text> : null}
          </View>
        ))}
      </View>
      {t.status === "closed" ? <Banner kind="info" text="This ticket is closed. Contact support again if you still need help." /> : (
        <View style={{ marginTop: spacing.lg }}>
          <Field label="Reply" value={text} onChangeText={setText} multiline style={[s.input, { minHeight: 70, textAlignVertical: "top" }]} />
          {photo ? <Text style={s.hint}>Photo ready to send · <Text onPress={() => setPhoto(null)} style={{ color: colors.primaryDark }}>remove</Text></Text>
            : <Button title="Add a photo" kind="secondary" onPress={() => pickPhoto("camera").then(setPhoto).catch((e: Error) => setErr(e.message))} />}
          <Banner text={err} />
          <Button title="Send" busy={busy} disabled={!text.trim() && !photo} onPress={send} />
        </View>
      )}
    </View>
  );
}

export type SupportView = "help" | "article" | "report" | "tickets" | "ticket";
export type SupportParams = { view?: string; slug?: string; tracking?: string; id?: string; who?: string };

/** One screen for all of support; each app passes its own navigation (expo-router) in. */
export function SupportScreen({ who, p, go, back }: { who: Asker; p: SupportParams; go: (p: SupportParams) => void; back: () => void }) {
  const view = (p.view ?? "help") as SupportView;
  const [done, setDone] = useState<string | null>(null);
  const heading: Record<SupportView, [string, string?]> = {
    help: ["Help", "Answers to common questions"], article: ["Help"], tickets: ["My tickets"], ticket: ["Support"],
    report: [p.tracking ? "Report a problem" : "Contact support", p.tracking ? `Delivery ${p.tracking}` : "Tell us how we can help"],
  };
  return (
    <View>
      <Pressable onPress={back} accessibilityRole="button" style={{ marginBottom: spacing.md }}><Text style={{ color: colors.primaryDark, fontWeight: "600" }}>← Back</Text></Pressable>
      {view !== "article" && view !== "ticket" && <><Text style={s.title}>{heading[view][0]}</Text>{heading[view][1] ? <Text style={[s.sub, { marginBottom: spacing.md }]}>{heading[view][1]}</Text> : null}</>}
      <Banner kind="success" text={done} />
      {view === "help" && <HelpCentre who={who} onArticle={(slug) => go({ view: "article", slug })} onContact={() => go({ view: "report" })} onTickets={() => go({ view: "tickets" })} />}
      {view === "article" && p.slug && <><HelpArticleView slug={p.slug} /><View style={{ marginTop: spacing.lg }}><Button title="Still need help? Contact support" kind="secondary" onPress={() => go({ view: "report" })} /></View></>}
      {view === "report" && <ReportProblem who={who} tracking={p.tracking} onDone={(id, msg) => { setDone(msg); go({ view: "ticket", id }); }} />}
      {view === "tickets" && <MyTickets onOpen={(id) => go({ view: "ticket", id })} />}
      {view === "ticket" && p.id && <TicketThread id={p.id} />}
    </View>
  );
}
