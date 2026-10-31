import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "./_ui/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Bart", template: "%s · Bart" },
  description: "Reading notes and contacts for Bart",
};

export const viewport: Viewport = { colorScheme: "light dark" };

// The dashboard has no login (a hackathon decision). The /api/* routes keep their x-bart-token check.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link className="brand" href="/notes">
            Bart
          </Link>
          <Nav />
        </header>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
