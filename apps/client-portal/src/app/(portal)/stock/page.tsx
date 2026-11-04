import { supabaseServer } from "@/lib/supabase/server";
import { ghs } from "@/lib/money";
import { currentVendor } from "../vendor";
import { ProductForm } from "./product-form";

const when = (d: string) => new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const KIND: Record<string, string> = { receive: "Received", pick: "Sent (order)", adjust: "Correction", return: "Returned", move: "Moved shelf" };

/** My products stored at QCS hubs: what's there, what's reserved for orders, low-stock warnings, and every movement. */
export default async function StockPage() {
  const { vendor } = await currentVendor();
  const sb = await supabaseServer();
  const [{ data: v }, { data: skus }, { data: levels }, { data: moves }, { data: charges }, { data: hubs }] = await Promise.all([
    sb.from("vendors").select("fulfilment_enabled").eq("id", vendor.id).single(),
    sb.from("skus").select("id, sku, name, barcode, weight_g, unit_value, low_stock_at, is_active").eq("vendor_id", vendor.id).order("name"),
    sb.from("stock_levels").select("hub_id, sku_id, on_hand, reserved, available, low_stock_at, locations").eq("vendor_id", vendor.id),
    sb.from("stock_movements").select("created_at, kind, change, location, reference, sku_id, hub_id").eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(40),
    sb.from("fulfilment_charges").select("kind, period, units, amount, created_at").eq("vendor_id", vendor.id).order("created_at", { ascending: false }).limit(12),
    sb.from("hubs").select("id, name").eq("is_active", true),
  ]);
  const hubName = (id: string) => hubs?.find((h) => h.id === id)?.name ?? "hub";
  const skuName = (id: string) => skus?.find((s) => s.id === id)?.name ?? "product";
  if (!v?.fulfilment_enabled) {
    return (<><h1>Stock</h1><div className="card"><strong>Store your products at a QCS hub</strong>
      <p>QCS keeps your stock, picks and packs each order and delivers it — same day in the city, by bus to other cities. You pay a small monthly storage fee per item and a pick &amp; pack fee per order.</p>
      <p className="muted">Ask your QCS account manager to switch fulfilment on.</p></div></>);
  }
  return (
    <>
      <h1>Stock</h1>
      <p className="muted">Send products to a QCS hub; the hub counts them in. To ship, book a delivery and choose “My stock at …”.</p>
      <h2>At the hubs</h2>
      <table>
        <thead><tr><th>Product</th><th>Hub</th><th>On the shelf</th><th>Reserved for orders</th><th>Available</th></tr></thead>
        <tbody>
          {(levels ?? []).map((l) => (
            <tr key={`${l.hub_id}-${l.sku_id}`} className={l.available <= l.low_stock_at ? "bad" : undefined}>
              <td>{skuName(l.sku_id)}</td><td>{hubName(l.hub_id)}</td><td>{l.on_hand}</td><td>{l.reserved}</td>
              <td><strong>{l.available}</strong>{l.available <= l.low_stock_at && <span className="tag" style={{ marginLeft: 6 }}>low — send more</span>}</td>
            </tr>
          ))}
          {!levels?.length && <tr><td colSpan={5} className="muted">Nothing at a hub yet.</td></tr>}
        </tbody>
      </table>

      <h2>Products</h2>
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Barcode</th><th>Weight</th><th>Value</th><th>Warn me at</th><th></th></tr></thead>
        <tbody>
          {(skus ?? []).map((s) => <ProductForm key={s.id} vendorId={vendor.id} p={s} />)}
          <ProductForm vendorId={vendor.id} p={null} />
        </tbody>
      </table>

      <h2>Recent movements</h2>
      <table>
        <tbody>{(moves ?? []).map((m, i) => (
          <tr key={i}><td>{when(m.created_at)}</td><td>{KIND[m.kind] ?? m.kind}</td><td>{skuName(m.sku_id)}</td><td>{m.change > 0 ? `+${m.change}` : m.change}</td>
            <td className="muted">{hubName(m.hub_id)} · shelf {m.location}{m.reference ? ` · ${m.reference}` : ""}</td></tr>))}
          {!moves?.length && <tr><td className="muted">No movements yet.</td></tr>}</tbody>
      </table>

      <h2>Fulfilment charges</h2>
      <table><tbody>{(charges ?? []).map((c, i) => <tr key={i}><td>{when(c.created_at)}</td><td>{c.kind === "storage" ? `Storage ${c.period?.slice(0, 7)}` : "Pick & pack"}</td><td>{c.units} item(s)</td><td>{ghs(c.amount)}</td></tr>)}
        {!charges?.length && <tr><td className="muted">None yet.</td></tr>}</tbody></table>
    </>
  );
}
