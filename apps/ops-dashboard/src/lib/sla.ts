/** Support ticket SLA badge — mirrors ticket_sla_state() in the database. */
export interface SlaTicket { status: string; first_responded_at: string | null; first_response_due: string | null; resolution_due: string | null; resolved_at: string | null }

export function slaState(t: SlaTicket, now = Date.now()): { text: string; cls: "bad" | "warn" | "ok" | "idle" } {
  const due1 = t.first_response_due ? Date.parse(t.first_response_due) : null;
  const due2 = t.resolution_due ? Date.parse(t.resolution_due) : null;
  if (t.status === "resolved" || t.status === "closed") {
    return t.resolved_at && due2 && Date.parse(t.resolved_at) > due2 ? { text: "resolved late", cls: "warn" } : { text: "SLA met", cls: "ok" };
  }
  if (!t.first_responded_at && due1 && now > due1) return { text: `reply overdue ${ago(now - due1)}`, cls: "bad" };
  if (t.status === "open" && due2 && now > due2) return { text: `resolution overdue ${ago(now - due2)}`, cls: "bad" };
  if (!t.first_responded_at && due1) return { text: `reply in ${ago(due1 - now)}`, cls: due1 - now < 15 * 60_000 ? "warn" : "ok" };
  if (t.status === "pending") return { text: "waiting for customer", cls: "idle" };
  return { text: due2 ? `resolve in ${ago(due2 - now)}` : "on track", cls: "ok" };
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

export const CATEGORIES: [string, string][] = [
  ["general", "General"], ["delay", "Late / where is it"], ["damaged", "Damaged"], ["missing", "Missing / lost"], ["cod_money", "COD money"],
  ["rider", "Rider behaviour"], ["billing", "Billing / charges"], ["address", "Address / location"], ["account", "Account"], ["payout", "Payout"],
  ["app", "App problem"], ["other", "Other"],
];
export const catText = (c: string) => CATEGORIES.find(([k]) => k === c)?.[1] ?? c;
export const STAGES: [string, string][] = [
  ["new", "New"], ["contacted", "Contacted"], ["trial", "Trial"], ["active", "Active"], ["churn_risk", "Churn risk"], ["churned", "Churned"], ["lost", "Lost"],
];

/** WhatsApp lets us reply in free text for 24 hours after the customer's last message. */
export const waWindowOpen = (lastCustomerAt: string | null) => !!lastCustomerAt && Date.now() - Date.parse(lastCustomerAt) < 24 * 3600_000;
