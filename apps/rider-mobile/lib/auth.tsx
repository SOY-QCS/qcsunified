import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { loadAccount, supabase, type Account } from "@qcs/mobile";

interface AuthState { ready: boolean; session: Session | null; account: Account | null; refresh: () => Promise<void> }
const Ctx = createContext<AuthState>({ ready: false, session: null, account: null, refresh: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<Account | null>(null);

  const refresh = useCallback(async () => {
    try { setAccount(await loadAccount()); } catch { setAccount(null); }
  }, []);

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await refresh();
      setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      if (s) await refresh(); else setAccount(null);
    });
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  return <Ctx.Provider value={{ ready, session, account, refresh }}>{children}</Ctx.Provider>;
}

/** Which part of the rider app this person should see. */
export type RiderPlace = "apply" | "pending" | "home" | "hub" | "blocked";
export function placeFor(a: Account): RiderPlace {
  const isHub = a.roles.some((r) => r.role === "hub_handler");
  if (isHub && !a.rider) return "hub";               // hub handlers only see Hub mode (CLAUDE.md §4)
  const status = a.rider?.status;
  if (!status || status === "applicant" || status === "rejected") return "apply";
  if (status === "pending") return "pending";
  if (status === "active") return "home";
  return "blocked";
}
