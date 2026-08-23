import { experimental_upgradeWebSocket } from "@vercel/functions";
import { registerGameSocket } from "@/lib/realtime-game";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    return await experimental_upgradeWebSocket((socket) => {
      registerGameSocket(socket);
    }, { maxPayload: 100_000 });
  } catch (error) {
    console.error("[FlickXI] WebSocket upgrade failed", error);
    return Response.json({ error: "WebSocket upgrade failed" }, { status: 500 });
  }
}
