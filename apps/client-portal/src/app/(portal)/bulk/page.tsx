import { currentVendor } from "../vendor";
import { BulkUpload } from "./bulk-upload";

export default async function BulkPage() {
  const { vendor, me } = await currentVendor();
  return (<><h1>Bulk upload</h1><BulkUpload vendor={vendor} me={me} /></>);
}
