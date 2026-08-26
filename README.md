# FlickXI Table Soccer

FlickXI is a mobile-first, two-player table-soccer game. The Next.js UI and physics run in the browser, while a Cloudflare Durable Object handles matchmaking, private rooms, turns, shots, chat, emoji reactions, bots, synchronization, rematches, and reconnect recovery over WebSockets.

## Local development

Install dependencies, then run the Cloudflare realtime service and Next.js app in separate terminals:

```bash
npm install
npm run dev:cloudflare
```

```bash
$env:NEXT_PUBLIC_REALTIME_URL="http://127.0.0.1:8787/ws"
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in two browser windows. The Cloudflare protocol smoke test can be run while Wrangler is running:

```bash
npm run test:cloudflare
```

## Production

```bash
npm run lint
npm run build
npm run deploy:cloudflare
```

Copy the deployed `workers.dev` URL and add it to Vercel as a Production environment variable, including the `/ws` path:

```env
NEXT_PUBLIC_REALTIME_URL=https://flickxi-realtime.your-account.workers.dev/ws
```

Redeploy the Vercel project after adding the variable. The app's `/api/presence` route automatically proxies the Worker's `/presence` endpoint.

`REDIS_URL` and the existing `/api/ws` implementation remain only as a legacy local fallback when `NEXT_PUBLIC_REALTIME_URL` is absent; production does not need Upstash Redis.

## Optional Google sign-in

Guest play always remains available. To enable the Google account button:

1. Add Clerk from the Vercel Marketplace, or run `vercel integration add clerk`.
2. In the Clerk dashboard, enable Google under social connections.
3. Confirm Vercel has provisioned `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
4. Redeploy the application.

For local testing, copy `.env.example` to `.env.local` and add the two Clerk keys. When the keys are absent, the Clerk provider and account UI stay disabled without affecting guest matchmaking.
