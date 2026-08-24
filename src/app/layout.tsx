import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
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
  const clerkEnabled = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  );
  return (
    <html lang="en" className={roboto.variable}>
      <body>{clerkEnabled ? <ClerkProvider>{children}</ClerkProvider> : children}</body>
    </html>
  );
}
