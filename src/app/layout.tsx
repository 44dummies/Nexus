import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "DerivNexus | Automated Trading Terminal",
  description: "Next-generation 3D-enabled automated trading bot for Deriv API. High-performance trading with a sci-fi terminal experience.",
  keywords: ["trading", "deriv", "forex", "bot", "automated trading", "fintech"],
  authors: [{ name: "DerivNexus" }],
  openGraph: {
    title: "DerivNexus | Automated Trading Terminal",
    description: "Next-generation 3D-enabled automated trading bot for Deriv API",
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
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
