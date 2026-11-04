import { currentVendor } from "../vendor";
import { WalletView } from "./wallet-view";

export default async function WalletPage() {
  const { vendor } = await currentVendor();
  return (<><h1>Wallet &amp; statements</h1><WalletView vendorId={vendor.id} /></>);
}
