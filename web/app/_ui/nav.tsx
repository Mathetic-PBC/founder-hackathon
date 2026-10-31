"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/notes", label: "Notes" },
  { href: "/books", label: "Books" },
  { href: "/contacts", label: "Contacts" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Dashboard">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path.startsWith(i.href) ? "page" : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
