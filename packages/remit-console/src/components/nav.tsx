"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SCREENS = [
  { href: "/", label: "Overview" },
  { href: "/review", label: "Review" },
  { href: "/ledger", label: "Ledger" },
  { href: "/remit", label: "Remit" },
  { href: "/kill", label: "Kill switch" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav>
      {SCREENS.map((screen) => (
        <Link
          key={screen.href}
          href={screen.href}
          {...(pathname === screen.href ? { "aria-current": "page" as const } : {})}
        >
          {screen.label}
        </Link>
      ))}
    </nav>
  );
}
