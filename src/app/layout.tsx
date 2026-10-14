import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SWARM TAB",
  description:
    "AI agents compare Base token liquidity and indicative exit quotes within one onchain spending budget",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        {children}
      </body>
    </html>
  );
}
