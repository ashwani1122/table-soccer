# FlickXI Table Soccer

FlickXI is a mobile-first, two-player table-soccer game built entirely with Next.js. The UI and physics run in the browser, while `/api/ws` handles matchmaking, private rooms, turns, shots, chat, emoji reactions, synchronization, and rematches over WebSockets.

## Local development

The WebSocket upgrade API requires the Vercel runtime. Run the complete realtime game with:

```bash
npm run dev:realtime
```

Then open [http://localhost:3000](http://localhost:3000) in two browser windows.

For UI-only work, the normal Next.js development server is still available:

```bash
npm run dev
```

The `/api/ws` connection does not work under plain `next dev`.

## Production

```bash
npm run lint
npm run build
```

Deploy the repository directly to Vercel. No separate Node.js, Render, or Koyeb service is used.

For reliable matchmaking across multiple Vercel Function instances, add an Upstash Redis integration to the Vercel project. It supplies the required `REDIS_URL`. Without it, the game intentionally falls back to single-instance in-memory state for local protocol tests.

## Optional Google sign-in

Guest play always remains available. To enable the Google account button:

1. Add Clerk from the Vercel Marketplace, or run `vercel integration add clerk`.
2. In the Clerk dashboard, enable Google under social connections.
3. Confirm Vercel has provisioned `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
4. Redeploy the application.

For local testing, copy `.env.example` to `.env.local` and add the two Clerk keys. When the keys are absent, the Clerk provider and account UI stay disabled without affecting guest matchmaking.
