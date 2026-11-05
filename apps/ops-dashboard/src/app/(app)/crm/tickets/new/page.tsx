import Link from "next/link";
import { requireRole } from "@/lib/session";
import { supabaseServer } from "@/lib/supabase/server";
import { myCities } from "@/lib/ops";
import { CrmTabs } from "../../tabs";
import { NewTicketForm } from "./form";

/** Support logs a phone call, walk-in or email as a ticket (it is assigned to them). */
export default async function NewTicket({ searchParams }: PageProps<"/crm/tickets/new">) {
  const me = await requireRole(["super_admin", "city_admin", "support", "dispatcher"]);
  const sp = await searchParams;
  const { cities } = await myCities(await supabaseServer(), me);
  const tn = typeof sp.tracking === "string" ? sp.tracking : "";
  const phone = typeof sp.phone === "string" ? sp.phone : "";
  return (
    <>
      <p><Link href="/crm/tickets">← Tickets</Link></p>
      <h1>Log a call</h1>
      <CrmTabs at="/crm/tickets" />
      <NewTicketForm cities={cities.map((c) => ({ id: c.id, name: c.name }))} tracking={tn} phone={phone} />
    </>
  );
}
