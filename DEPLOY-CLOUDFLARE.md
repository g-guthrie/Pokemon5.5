# Free Cloudflare deployment

This app is a long-running Node server (WebSockets, in-process battle
simulator, artifact writes), so it cannot run on Cloudflare Workers' free
compute, and Cloudflare's container platform is paid. The free Cloudflare
path is a **Tunnel**: the server runs on a machine you control and
Cloudflare's edge fronts it with TLS, WebSocket proxying, DDoS protection,
and a public URL. The machine only makes outbound connections — no port
forwarding, no exposed ports.

## Option A — instant demo URL (no Cloudflare account)

Ephemeral `trycloudflare.com` URL that changes every run. Good for showing
someone the site today, not for a stable link.

```sh
npm start                                   # arena on http://localhost:3107
cloudflared tunnel --url http://localhost:3107
```

cloudflared prints a `https://<random>.trycloudflare.com` URL. WebSockets
work out of the box. Ctrl-C ends the exposure.

## Option B — durable free tunnel on your own domain

Needs a free Cloudflare account and a domain using Cloudflare DNS
(domain registration is the only cost in the whole setup).

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a
   tunnel** (Cloudflared connector). Copy the tunnel token.
2. Add a public hostname to the tunnel, e.g. `arena.yourdomain.com`,
   pointing at service `http://arena:8123`.
3. On the host machine:

   ```sh
   TUNNEL_TOKEN=eyJ... docker compose up -d --build
   ```

That's it: `docker-compose.yml` runs the arena container (artifacts on a
named volume, `TRUST_PROXY=1` so Cloudflare-forwarded IPs drive the rate
limits) plus a `cloudflared` sidecar that keeps the tunnel up and
auto-restarts. `GET /healthz` reports server health.

Without Docker, the same thing as bare processes:

```sh
TRUST_PROXY=1 PORT=8123 npm start
cloudflared service install <TUNNEL_TOKEN>    # runs as a system service
```

## Operational notes

- The host must stay on and online; a Mac mini, spare laptop with lid-close
  sleep disabled, or any small always-on box works.
- Visitors bring their own OpenRouter keys (held in memory per run); the
  demo battle is free stand-ins. Set `OPENROUTER_API_KEY` only if you want
  a house key.
- `MAX_CONCURRENT_RUNS` (default 3) caps simultaneous live matches;
  `MAX_LIVE_ARTIFACTS` (default 400) caps retained replays.
- Optional hardening: put the `/operator.html` console behind Cloudflare
  Access (free for small teams) so only you can reach the operator
  controls.
