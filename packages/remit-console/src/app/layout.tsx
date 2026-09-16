import { Martian_Mono, Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { activeNetwork } from "@/lib/paths";
import "./globals.css";

/**
 * Two families, self-hosted through next/font so the page never waits on a third party
 * and never shifts as it loads.
 *
 * Martian Mono is set narrow. Every hash, address and figure on these screens is
 * monospace, and at its default width a truncated hash costs half a column.
 */
const text = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-text",
  display: "swap",
});

const data = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-data",
  display: "swap",
});

export const metadata = {
  title: "Remit",
  description: "An agent may remit only within its remit.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${data.variable}`}>
      <body>
        <header className="band">
          <div className="band-inner">
            <span className="wordmark">Remit</span>
            <span className="creed">An agent may remit only within its remit.</span>
            <Nav />
            <span className="network">{activeNetwork()}</span>
          </div>
        </header>

        <main>
          <div className="spine">{children}</div>
        </main>

        <footer className="band">
          <div className="band-inner">
            <span>{activeNetwork()} · operator console</span>
            <span>reads the repository · holds no key · submits nothing</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
