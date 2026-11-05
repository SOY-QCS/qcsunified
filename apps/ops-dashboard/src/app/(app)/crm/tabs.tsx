import Link from "next/link";

const TABS = [
  ["/crm", "Overview"], ["/crm/tickets", "Tickets"], ["/crm/tickets?channel=whatsapp", "WhatsApp inbox"], ["/crm/customers", "Customers"],
  ["/crm/leads", "Leads"], ["/crm/alerts", "Churn alerts"], ["/crm/campaigns", "Campaigns"], ["/crm/service", "Customer service"], ["/crm/help", "Help centre"],
] as const;

export function CrmTabs({ at }: { at: string }) {
  return <div className="tabs" style={{ flexWrap: "wrap", marginBottom: 16 }}>
    {TABS.map(([h, l]) => <Link key={h} href={h} className={`btn small ${at === h ? "" : "secondary"}`}>{l}</Link>)}
  </div>;
}

export const CRM_ROLES = ["super_admin", "city_admin", "support", "analyst"] as const;
export const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null);
