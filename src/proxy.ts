import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const clerkEnabled = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);
const handleClerkRequest = clerkEnabled ? clerkMiddleware() : null;

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname === "/api/ws") return NextResponse.next();
  return handleClerkRequest ? handleClerkRequest(request, event) : NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)",
    "/(api)(.*)",
  ],
};
