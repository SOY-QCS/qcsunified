import { useEffect, useState } from "react";
import { supabase } from "@qcs/mobile";

export interface City { id: string; code: string; name: string }

export function useCities() {
  const [cities, setCities] = useState<City[]>([]);
  useEffect(() => {
    supabase().from("cities").select("id, code, name").eq("is_active", true).order("name").then(({ data }) => setCities(data ?? []));
  }, []);
  return cities;
}

/** Link to the client Terms & Conditions (an admin setting). */
export function useTermsUrl() {
  const [url, setUrl] = useState("https://qcsghana.com/terms");
  useEffect(() => {
    supabase().from("app_settings").select("value").eq("key", "terms_url").is("city_id", null).maybeSingle()
      .then(({ data }) => { if (data?.value) setUrl(String(data.value)); });
  }, []);
  return url;
}
