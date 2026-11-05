import { Notices } from "./notices";
import { TopNav } from "./top-nav";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav />
      <Notices />
      <main className="main" style={{ margin: "0 auto" }}>{children}</main>
    </>
  );
}
