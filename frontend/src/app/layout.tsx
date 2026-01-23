import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import AppLayout from "@/components/layout/AppLayout";
import "./globals.css";

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
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="institutional"
          themes={["institutional", "midnight", "cyberpunk"]}
          enableSystem={false}
        >
          <AppLayout>{children}</AppLayout>
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: 'var(--toast-bg)',
                color: 'var(--toast-fg)',
                border: '1px solid var(--toast-border)',
              },
              classNames: {
                error: 'toast-error',
                success: 'toast-success',
                warning: 'toast-warning',
                info: 'toast-info',
              },
            }}
            richColors
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
