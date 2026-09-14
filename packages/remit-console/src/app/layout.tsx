import Link from "next/link";
import type { ReactNode } from "react";
import { activeNetwork } from "@/lib/paths";
import "./globals.css";

export const metadata = {
  title: "Remit",
  description: "An agent may remit only within its remit.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/review", label: "Review" },
  { href: "/ledger", label: "Ledger" },
  { href: "/remit", label: "Remit" },
  { href: "/kill", label: "Kill switch" },
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <div className="brand">
            <strong>Remit</strong>
            <span className="tagline">An agent may remit only within its remit.</span>
          </div>
          <nav>
            {NAV.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="network">{activeNetwork()}</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
