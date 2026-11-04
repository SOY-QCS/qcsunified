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
