import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Your Storybook — Cart & Checkout",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-cream text-ink">{children}</body>
    </html>
  );
}
