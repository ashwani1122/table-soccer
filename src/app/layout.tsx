import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlickXI — Physics Table Football",
  description:
    "A mobile-first tabletop football game with pull-back controls and physics-based pass chains.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
