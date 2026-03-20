# omnia-mcp-proxy — Cloudflare Worker

Shared CORS proxy worker for all Omnia Housing PWAs. Sits between browser apps and backend services.

**Worker URL:** https://omnia-mcp-proxy.liveomnia.workers.dev
**Wrangler name:** `omnia-mcp-proxy`
**Repo:** https://github.com/samirpatel-cloud/omnia-mcp-proxy

## Omnia Platform — Repo Map

| Repo | Purpose | Live URL |
|------|---------|----------|
| [`OmniaDashboard`](https://github.com/samirpatel-cloud/OmniaDashboard) | Executive weekly stats PWA | https://weeklystats.liveomnia.com |
| [`omnia-app`](https://github.com/samirpatel-cloud/omnia-app) | Tenants + Compliance unified PWA | https://omniaapp.liveomnia.com |
| [`omnia-mcp-proxy`](https://github.com/samirpatel-cloud/omnia-mcp-proxy) | Shared Cloudflare Worker (this repo) | https://omnia-mcp-proxy.liveomnia.workers.dev |

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | POST | SQL MCP proxy — forwards JSON-RPC to Veco SQL Server |
| `/docs` | POST | Docs MCP proxy — forwards to document retrieval service |
| `/summarize` | POST | Claude AI proxy — sends tenant notes to Anthropic API, returns structured summary |
| `/asana/*` | GET | Asana REST API proxy — forwards with PAT auth |

## Consuming Apps

| App | Repo | Live URL |
|-----|------|----------|
| **Omnia Dashboard** | `OmniaDashboard` | https://weeklystats.liveomnia.com |
| **Omnia App** (Tenants + Compliance) | `omnia-app` | https://omniaapp.liveomnia.com |

## Environment Variables (wrangler.toml)

| Variable | Purpose |
|----------|---------|
| `SQL_MCP_TARGET` | MCP SQL Server endpoint URL |
| `DOCS_MCP_TARGET` | MCP Docs endpoint URL |
| `ALLOWED_ORIGIN` | Primary allowed origin for CORS |
| `ASANA_PAT` | Asana Personal Access Token |

## Secrets (via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude API key for `/summarize` route |
| `CF_ACCESS_AUD` | (optional) Cloudflare Access audience tag for JWT verification on `/summarize` |
| `API_KEY` | Shared secret required on all SQL/Docs requests via `X-Api-Key` header |

## CORS

Allowed origins are hardcoded in `index.js`:
- `localhost:5173-5176` (dev)
- `*.omnia-tenants.pages.dev`, `tenants.liveomnia.com`
- `*.omnia-app.pages.dev`, `omnia-app.pages.dev`, `omniaapp.liveomnia.com`
- `*.omnia-arrears.pages.dev`, `arrears.liveomnia.com`
- `*.omnia-dashboard.pages.dev`, `weeklystats.liveomnia.com`

## API Key Authentication

SQL (`/`) and Docs (`/docs`) routes require an `X-Api-Key` header matching the `API_KEY` secret.
Requests without the correct key receive `401 Unauthorized`.
Dev mode (localhost) skips this check — the key is only sent in production builds.

## /summarize Route Details

- Calls Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
- Input limits: 10 notes max, 800 chars/note, 8000 chars total
- 15s timeout via AbortController
- Handles 429 rate-limit, malformed responses
- Structured prompt: Current issue, Key dates, Actions taken, Risk level, Next step
- Does not log raw note content

## Deploy

```bash
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY
```

## Local Dev

Other apps proxy to this worker in dev via Vite config:
```js
'/summarize': { target: 'https://omnia-mcp-proxy.liveomnia.workers.dev', changeOrigin: true }
```
