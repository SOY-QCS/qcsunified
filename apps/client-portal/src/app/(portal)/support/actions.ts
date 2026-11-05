"use server";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

type R = { ok: boolean; message: string; id?: string };

/** "Report a problem" / "Contact support". The database checks the delivery is this vendor's and sets the priority. */
export async function openTicket(category: string, body: string, tracking: string | null, photo: string | null): Promise<R> {
  const { data, error } = await (await supabaseServer()).rpc("open_ticket", { p_category: category, p_body: body, p_tracking: tracking || null, p_subject: null, p_attachment: photo });
  revalidatePath("/support");
  if (error) return { ok: false, message: error.message };
  const r = data as { id: string; number: number; existing: boolean };
  return { ok: true, id: r.id, message: r.existing ? `Added to your open ticket #${r.number}` : `Ticket #${r.number} sent. We'll reply here and by notification.` };
}

export async function replyTicket(ticket: string, body: string, photo: string | null): Promise<R> {
  const { error } = await (await supabaseServer()).rpc("reply_ticket", { p_ticket: ticket, p_body: body, p_internal: false, p_attachment: photo, p_resolve: false });
  revalidatePath(`/support/${ticket}`);
  return error ? { ok: false, message: error.message } : { ok: true, message: "Sent" };
}
