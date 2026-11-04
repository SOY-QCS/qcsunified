"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "@qcs/types";
import { signOut } from "./actions";

export function SideNav({ items, name, roles }: { items: NavItem[]; name: string; roles: string[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand"><span className="brand-mark">Q</span>QCS Operations</div>
      <button className="btn secondary small menu-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>Menu</button>
      <nav onClick={() => setOpen(false)}>
        {items.map((n) => (
          <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
            {n.label}{!n.ready && <span className="soon">soon</span>}
          </Link>
        ))}
      </nav>
      <div className="who">
        <strong>{name}</strong>
        {roles.map((r) => <div key={r}>{r}</div>)}
        <form action={signOut}><button className="btn secondary small" style={{ marginTop: 10 }}>Sign out</button></form>
      </div>
    </aside>
  );
}
