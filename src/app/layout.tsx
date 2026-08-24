import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import "./globals.css";

const roboto = Roboto({
  subsets: ["latin"],
  weight: "variable",
  style: "normal",
  display: "swap",
  variable: "--font-roboto",
});

export const metadata: Metadata = {
  title: "FlickXI — Physics Table Football",
  description:
    "A mobile-first tabletop football game with pull-back controls and physics-based pass chains.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={roboto.variable}>
      <body>{children}</body>
    </html>
  );
}
