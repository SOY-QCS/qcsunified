"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "./actions";

const LINKS = [{ href: "/", label: "Home" }, { href: "/book", label: "Book" }, { href: "/bulk", label: "Bulk upload" }, { href: "/orders", label: "Orders" }, { href: "/wallet", label: "Wallet" }];

export function TopNav() {
  const path = usePathname();
  return (
    <header className="topbar">
      <span className="brand" style={{ margin: 0 }}><span className="brand-mark">Q</span>QCS Business</span>
      <nav>{LINKS.map((l) => <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>)}</nav>
      <form action={signOut}><button className="btn secondary small">Sign out</button></form>
    </header>
  );
}
