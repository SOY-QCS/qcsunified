import { useLocalSearchParams, useRouter } from "expo-router";
import { Screen, SupportScreen, type SupportParams } from "@qcs/mobile";
import { useAuth } from "../../lib/auth";

/** Help centre, "Report a problem" and my tickets. Vendors in business mode ask as the business. */
export default function Support() {
  const p = useLocalSearchParams<SupportParams>();
  const router = useRouter();
  const { account } = useAuth();
  const who = p.who === "vendor" && account?.vendor ? "vendor" : "client";
  return (
    <Screen>
      <SupportScreen who={who} p={p} go={(next) => router.push({ pathname: "/support", params: { ...next, who } })}
        back={() => (router.canGoBack() ? router.back() : router.replace("/home"))} />
    </Screen>
  );
}
