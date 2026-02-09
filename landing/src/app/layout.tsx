import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ax — Open Source AI Agent Framework",
  description:
    "A free, open source framework for building always-on AI agents. Pluggable tools, any LLM, persistent memory — from prototype to production.",
  openGraph: {
    title: "ax — Open Source AI Agent Framework",
    description:
      "A free, open source framework for building always-on AI agents. Pluggable tools, any LLM, persistent memory.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased bg-bg-primary text-text-primary`}
      >
        {children}
      </body>
    </html>
  );
}
