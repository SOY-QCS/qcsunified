import Link from "next/link";

const TABS = [["/finance", "Overview"], ["/finance/payouts", "Payout batches"], ["/finance/cod", "COD cash"], ["/finance/export", "Export"]] as const;
export function FinanceTabs({ at }: { at: string }) {
  return <div className="tabs" style={{ flexWrap: "wrap", marginBottom: 16 }}>{TABS.map(([h, l]) => <Link key={h} href={h} className={`btn small ${at === h ? "" : "secondary"}`}>{l}</Link>)}</div>;
}
