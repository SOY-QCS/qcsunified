export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div className="brand">
      <span className="brand-mark">Q</span>
      <span>QCS Operations<br /><span className="muted" style={{ fontWeight: 400 }}>{subtitle}</span></span>
    </div>
  );
}

/** Turn Supabase error messages into plain language. */
export function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "Wrong email/phone or password.";
  if (m.includes("email not confirmed")) return "Please accept your invite email first.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("weak") || m.includes("password should")) return "Password too weak: use at least 10 characters with upper and lower case letters and a number.";
  if (m.includes("token has expired") || m.includes("invalid otp") || m.includes("otp")) return "That code is wrong or has expired.";
  if (m.includes("fetch")) return "Can't reach the server. Check your internet connection.";
  return message;
}
