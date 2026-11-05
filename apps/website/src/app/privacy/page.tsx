import Link from "next/link";
import { Shell } from "../shell";

export const metadata = { title: "Privacy notice · QCS Ghana", description: "What personal data QCS collects, why, who we share it with, and your rights." };

/**
 * DRAFT privacy notice describing what the QCS apps and website actually do.
 * Have it reviewed by a lawyer (Ghana Data Protection Act, 2012 — Act 843) before launch; keep it in step with the T&C.
 */
export default function Privacy() {
  return (
    <Shell>
      <h1>Privacy notice</h1>
      <p>QCS Ghana (Quality Courier Services) runs the QCS app, the QCS Rider app, the business portal and this website. This notice explains what personal
        data we use and why. Questions: support@qcsghana.com.</p>

      <h2 style={{ fontSize: 17 }}>What we collect</h2>
      <ul>
        <li><strong>Account:</strong> name, phone number (to sign in with a code), email if you give it, city, and whether you want offers.</li>
        <li><strong>Deliveries:</strong> pickup and drop-off addresses and map pins, recipient name and phone, parcel details, declared value, delivery codes,
          signatures and delivery photos, ratings, and messages with support.</li>
        <li><strong>Payments:</strong> amounts, wallet balance and the MoMo number used. Card and MoMo payments are handled by Hubtel; we never see your card number.</li>
        <li><strong>Riders:</strong> ID and vehicle documents, MoMo number for pay, and <strong>location while online</strong> (also in the background, shown by a
          permanent notification) so we can offer nearby jobs and show customers where their parcel is. No location is collected while offline.</li>
        <li><strong>Phone records:</strong> the app ID of the phone you sign in on, its model, and whether a fake-location app is in use — to keep
          accounts safe and prevent fraud. We do not read your contacts, messages or other apps.</li>
      </ul>

      <h2 style={{ fontSize: 17 }}>Why</h2>
      <ul>
        <li>To deliver your parcels: dispatch, tracking, proof of delivery, cash on delivery, claims.</li>
        <li>To take payments and pay riders and vendors.</li>
        <li>To keep the service safe: fraud checks, audit records, rate limits.</li>
        <li>To send delivery updates (app, SMS, WhatsApp, email — you choose in Settings) and, only if you opted in, offers you can stop at any time.</li>
      </ul>

      <h2 style={{ fontSize: 17 }}>Who sees it</h2>
      <ul>
        <li>The rider on your job sees the pickup and drop-off details and the contact phone numbers for that job only.</li>
        <li>Vendors see the deliveries they booked. QCS staff see what their role needs.</li>
        <li>Service providers that run parts of QCS for us: Supabase (database and storage), Vercel (website hosting), Google Maps (addresses and routes), Hubtel
          (payments and SMS), Meta WhatsApp, Resend (email), Expo (app notifications). We do not sell personal data.</li>
      </ul>

      <h2 style={{ fontSize: 17 }}>How long we keep it</h2>
      <ul>
        <li>Rider positions while idle: 7 days. Trip routes: kept with the delivery record.</li>
        <li>Delivery and payment records: as long as the law requires for business and tax records.</li>
        <li>Your account: until you delete it — see <Link href="/delete-account">Delete your account</Link>.</li>
      </ul>

      <h2 style={{ fontSize: 17 }}>Your rights</h2>
      <p>You can see and correct your details in the app, choose how we contact you, stop offers, and ask for a copy of your data or for your account to be deleted.
        Contact support@qcsghana.com. You can also complain to the Data Protection Commission of Ghana.</p>
      <p style={{ fontSize: 13, color: "#6b6b6b" }}>Last updated: November 2026.</p>
    </Shell>
  );
}
