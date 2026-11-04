import { BookingForm } from "@/components/booking-form";
import { currentVendor } from "../vendor";

export default async function BookPage() {
  const { vendor, me } = await currentVendor();
  return (<><h1>Book a delivery</h1><BookingForm vendor={vendor} me={me} /></>);
}
