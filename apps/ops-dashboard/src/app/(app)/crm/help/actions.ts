"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getStaff } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import type { Result } from "@/lib/rpc-action";

const Article = z.object({
  id: z.string().uuid().nullable(),
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/, "Web address: 3–60 lowercase letters, numbers or dashes"),
  audience: z.enum(["all", "client", "vendor", "rider"]),
  category: z.string().trim().min(2).max(40),
  title: z.string().trim().min(5).max(120),
  body: z.string().trim().min(20, "Write at least a couple of sentences").max(8000),
  sort: z.coerce.number().int().min(0).max(9999),
  published: z.boolean(),
});

/** Help articles and canned replies are plain table edits; the database only lets Support / Super Admin write them. */
export async function saveArticle(input: z.input<typeof Article>): Promise<Result> {
  const me = await getStaff();
  if (!me) return { ok: false, message: "Not signed in" };
  const p = Article.safeParse(input);
  if (!p.success) return { ok: false, message: p.error.issues[0]!.message };
  const { id, ...row } = p.data;
  const sb = await supabaseServer();
  const q = id ? sb.from("help_articles").update({ ...row, updated_by: me.id }).eq("id", id) : sb.from("help_articles").insert({ ...row, updated_by: me.id });
  const { data, error } = await q.select("id");
  revalidatePath("/crm/help");
  if (error) return { ok: false, message: error.code === "23505" ? "That web address is already used" : error.message };
  return data?.length ? { ok: true, message: "Saved", data: data[0]!.id } : { ok: false, message: "Only Support or a Super Admin can edit help articles" };
}

const Canned = z.object({ title: z.string().trim().min(3).max(60), body: z.string().trim().min(10).max(1000), category: z.string().nullable() });

export async function addCanned(input: z.input<typeof Canned>): Promise<Result> {
  const me = await getStaff();
  if (!me) return { ok: false, message: "Not signed in" };
  const p = Canned.safeParse(input);
  if (!p.success) return { ok: false, message: p.error.issues[0]!.message };
  const { data, error } = await (await supabaseServer()).from("canned_replies").insert({ ...p.data, created_by: me.id }).select("id");
  revalidatePath("/crm/help");
  if (error) return { ok: false, message: error.message.includes("row-level") ? "Only Support or an Admin can add canned replies" : error.message };
  return { ok: true, message: "Added", data: data?.[0]?.id };
}

export async function deleteCanned(id: string): Promise<Result> {
  if (!(await getStaff())) return { ok: false, message: "Not signed in" };
  const { data, error } = await (await supabaseServer()).from("canned_replies").delete().eq("id", id).select("id");
  revalidatePath("/crm/help");
  if (error) return { ok: false, message: error.message };
  return data?.length ? { ok: true, message: "Deleted" } : { ok: false, message: "Not allowed" };
}
