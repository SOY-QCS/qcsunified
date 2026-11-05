import { Shell } from "../shell";

export const metadata = { title: "Delete your QCS account · QCS Ghana", description: "How to delete your QCS or QCS Rider account and what happens to your data." };

/** Public page the app stores ask for: how to delete an account, also without the app. */
export default function DeleteAccount() {
  return (
    <Shell>
      <h1>Delete your QCS account</h1>
      <p>This applies to the <strong>QCS</strong> app, the <strong>QCS Rider</strong> app and the QCS business portal (QCS Ghana, Quality Courier Services).</p>
      <h2 style={{ fontSize: 17 }}>In the app</h2>
      <ul>
        <li><strong>QCS app:</strong> Settings → <em>Delete my account</em>.</li>
        <li><strong>QCS Rider app:</strong> Help &amp; support → <em>Delete my account</em>.</li>
      </ul>
      <h2 style={{ fontSize: 17 }}>Without the app</h2>
      <p>Send <strong>DELETE MY ACCOUNT</strong> on WhatsApp to the QCS support number, or email support@qcsghana.com, from the phone number or email on your account.
        We confirm it is you before deleting anything.</p>
      <h2 style={{ fontSize: 17 }}>What happens</h2>
      <ul>
        <li>We delete your account within <strong>30 days</strong>. You can cancel the request in the app until then.</li>
        <li>First we settle anything still owed: money in your wallet is sent to your MoMo number, riders hand in any COD cash, and business accounts are closed with the owner.</li>
        <li><strong>Deleted:</strong> your name, phone number, email, saved addresses, notification settings, phone (device) records and your sign-in.</li>
        <li><strong>Kept:</strong> records of past deliveries and payments (without your name or contact details), because the law requires us to keep business and tax records.
          Delivery photos and signatures are kept with those records.</li>
      </ul>
    </Shell>
  );
}
