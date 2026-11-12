import type { Metadata } from "next";
import { Inter, Pinyon_Script, Playfair_Display } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap" });
const pinyon = Pinyon_Script({ subsets: ["latin"], weight: "400", variable: "--font-pinyon", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "TripMate",
  description: "Plan group trips together. Commit with PayPal. Pay only when the group is ready.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${playfair.variable} ${pinyon.variable} ${inter.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <header className="mx-auto max-w-6xl px-4 pt-5">
          <nav className="flex items-center justify-between rounded-full bg-paper/80 px-3 py-2 text-xs shadow-sm ring-1 ring-sand backdrop-blur">
            <div className="flex gap-1.5">
              <Link href="/" className="rounded-full bg-sand/70 px-3 py-1.5 text-ink hover:bg-sand">My trips</Link>
              <Link href="/#create" className="hidden rounded-full bg-sand/70 px-3 py-1.5 text-ink hover:bg-sand sm:inline">New trip</Link>
            </div>
            <Link href="/" className="font-display text-lg tracking-wide text-ink">
              Trip<span className="font-script px-0.5 text-2xl text-clay">&amp;</span>Mate
            </Link>
            <span className="hidden rounded-full bg-sage px-3 py-1.5 text-white sm:inline">Powered by PayPal</span>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 pt-4 text-center text-xs text-muted">
          <span className="font-script text-xl text-sage">TripMate</span> · AI recommends, humans approve, PayPal executes
        </footer>
      </body>
    </html>
  );
}
