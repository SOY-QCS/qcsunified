"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GhanaPostGps, ID_TYPES, VENDOR_CATEGORIES } from "@qcs/types";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface City { id: string; code: string; name: string }

/** Business sign-up on the web (same rules as the app: name, category, pickup pin, ID). */
export default function Signup() {
  const router = useRouter();
  const sb = supabaseBrowser();
  const [cities, setCities] = useState<City[]>([]);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { sb.from("cities").select("id, code, name").order("name").then(({ data }) => setCities(data ?? [])); }, [sb]);

  function locate() {
    setError(null);
    if (!navigator.geolocation) return setError("This browser can't share location. Use the QCS app on your phone instead.");
    navigator.geolocation.getCurrentPosition(
      (p) => setPin({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setError("Allow location access, or set up your account in the QCS app while at your shop."),
      { enableHighAccuracy: true },
    );
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    const file = f.get("id_file") as File | null;
    if (!pin) return setError("Set your pickup pin with “Use my current location” while at the pickup point.");
    if (get("gps") && !GhanaPostGps.safeParse(get("gps")).success) return setError("Ghana Post GPS should look like GA-123-4567");
    if (!file || file.size === 0) return setError("Attach a photo or PDF of your ID");
    if (file.size > 5 * 1024 * 1024) return setError("ID file must be under 5 MB");

    setBusy(true);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { setBusy(false); return router.replace("/login"); }
    const ext = file.type === "application/pdf" ? "pdf" : "jpg";
    const path = `${user.id}/business-id-${Date.now()}.${ext}`;
    const up = await sb.storage.from("kyc").upload(path, file, { contentType: file.type || "image/jpeg" });
    if (up.error) { setBusy(false); return setError(`Upload failed: ${up.error.message}`); }

    await sb.from("profiles").update({ full_name: get("owner"), marketing_opt_in: f.get("opt_in") === "on" }).eq("id", user.id);
    const { error } = await sb.rpc("register_vendor", { p: {
      business_name: get("business"), category: get("category"), city_code: get("city"), contact_email: get("email") || null,
      id_type: get("id_type"), id_number: get("id_number"), id_doc_path: path,
      pickup: { formatted_address: get("address"), landmark: get("landmark") || null, ghana_post_gps: get("gps") || null, lat: pin.lat, lng: pin.lng, contact_name: get("owner") },
    } });
    setBusy(false);
    if (error) return setError(error.message);
    router.replace("/"); router.refresh();
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" style={{ maxWidth: 560 }} onSubmit={submit}>
        <h1>Set up your business</h1>
        <div className="row">
          <div><label htmlFor="owner">Your full name</label><input id="owner" name="owner" required minLength={2} /></div>
          <div><label htmlFor="email">Email (optional)</label><input id="email" name="email" type="email" /></div>
        </div>
        <label htmlFor="business">Business name</label><input id="business" name="business" required minLength={2} />
        <div className="row">
          <div><label htmlFor="category">Category</label>
            <select id="category" name="category" required defaultValue=""><option value="" disabled>Choose…</option>{VENDOR_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div><label htmlFor="city">City</label>
            <select id="city" name="city" required defaultValue=""><option value="" disabled>Choose…</option>{cities.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}</select></div>
        </div>
        <h2>Pickup point</h2>
        <label htmlFor="address">Address</label><input id="address" name="address" required placeholder="Shop 12, Oxford Street, Osu" />
        <div className="row">
          <div><label htmlFor="landmark">Landmark (optional)</label><input id="landmark" name="landmark" /></div>
          <div><label htmlFor="gps">Ghana Post GPS (optional)</label><input id="gps" name="gps" placeholder="GA-123-4567" /></div>
        </div>
        <button type="button" className="btn secondary block" onClick={locate}>{pin ? `📍 Pin set (${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}) — update` : "Use my current location"}</button>
        <h2>Identity</h2>
        <div className="row">
          <div><label htmlFor="id_type">ID type</label><select id="id_type" name="id_type" defaultValue="ghana_card">{ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
          <div><label htmlFor="id_number">ID number</label><input id="id_number" name="id_number" required minLength={4} /></div>
        </div>
        <label htmlFor="id_file">Photo or PDF of the ID</label><input id="id_file" name="id_file" type="file" accept="image/jpeg,image/png,application/pdf" required />
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}><input type="checkbox" name="opt_in" style={{ width: "auto" }} /> Send me offers and news from QCS</label>
        {error && <p className="error">{error}</p>}
        <button className="btn block" disabled={busy}>{busy ? "Creating…" : "Create business account"}</button>
      </form>
    </main>
  );
}
