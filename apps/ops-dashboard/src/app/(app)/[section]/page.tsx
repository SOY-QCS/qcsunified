import { notFound } from "next/navigation";
import { OPS_NAV } from "@qcs/types";

export default async function ComingSoon({ params }: PageProps<"/[section]">) {
  const { section } = await params;
  const item = OPS_NAV.find((n) => n.href === `/${section}`);
  if (!item) notFound();
  return (
    <>
      <h1>{item.label}</h1>
      <div className="card"><p className="muted">This screen is coming in a later phase.</p></div>
    </>
  );
}
