import { useCallback, useEffect, useState } from "react";
import { supabase } from "@qcs/mobile";

export interface Offer { id: string; expires_at: string; distance_m: number; trip_type: string; stops: number; cod_total: number; pickup: string; dropoff: string; fee: number }
export interface JobOrder {
  id: string; tracking_number: string; status: string; service_type: string;
  recipient_name: string; recipient_phone: string; pickup_address: string; pickup_contact: string; pickup_phone: string; pickup_note: string | null;
  pickup_lat: number; pickup_lng: number; dropoff_address: string; landmark: string | null; gps: string | null; note: string | null;
  dropoff_lat: number; dropoff_lng: number; weight_g: number; fragile: boolean; cod_amount: number;
  pod_photo_required: boolean; pickup_code_required: boolean; otp_verified: boolean; signature: boolean; photo: boolean; cod_collected: boolean;
}
export interface Job { trip: { id: string; status: string; trip_type: string }; orders: JobOrder[] }

/** The offer waiting for me: instant through Realtime, with a 5-second check as a safety net. */
export function useOffer(riderId: string, online: boolean) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const refresh = useCallback(async () => {
    const { data } = await supabase().rpc("my_offer");
    setOffer((data as Offer | null) ?? null);
  }, []);
  useEffect(() => {
    if (!online) { setOffer(null); return; }
    refresh();
    const ch = supabase().channel(`offers-${riderId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "job_offers", filter: `rider_id=eq.${riderId}` }, () => refresh())
      .subscribe();
    const t = setInterval(refresh, 5000);
    return () => { clearInterval(t); supabase().removeChannel(ch); };
  }, [riderId, online, refresh]);
  return { offer, refresh };
}

export function useJob() {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const { data } = await supabase().rpc("my_job");
    setJob((data as Job | null) ?? null);
    setLoading(false);
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 20_000); return () => clearInterval(t); }, [refresh]);
  return { job, loading, refresh, setJob };
}
