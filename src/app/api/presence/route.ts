import { getOnlinePlayerCount } from "@/lib/realtime-game";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const players = await getOnlinePlayerCount();
    return Response.json(
      { players },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[FlickXI] Could not read online player count", error);
    return Response.json({ players: 0 }, { status: 503 });
  }
}
