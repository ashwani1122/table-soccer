import { getOnlinePlayerCount } from "@/lib/realtime-game";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cloudflarePresenceUrl() {
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL?.trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "/presence";
  url.search = "";
  url.hash = "";
  return url;
}

export async function GET() {
  try {
    const workerUrl = cloudflarePresenceUrl();
    if (workerUrl) {
      const response = await fetch(workerUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error(`Realtime presence returned ${response.status}.`);
      const data = await response.json() as { players?: unknown };
      const players = Number(data.players);
      return Response.json(
        { players: Number.isFinite(players) ? Math.max(0, Math.floor(players)) : 0 },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
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
