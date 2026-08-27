import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shopify KiotViet Sync",
  description: "Production Shopify and KiotViet synchronization platform",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
