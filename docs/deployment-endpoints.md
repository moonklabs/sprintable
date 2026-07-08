# Deployment Endpoints

Current and historical deployment URLs for Sprintable.

## Active Endpoints

Customer-facing production runs behind Cloudflare on clean domains — treat these as canonical.
The direct Cloud Run URLs below them are infra-only (not customer-facing); use them for
debugging, not for docs/config that customers see.

### Customer-facing (canonical)

| Environment | Service | URL | Platform |
|---|---|---|---|
| Production | App (FE) | https://app.sprintable.ai | Cloudflare → `sprintable-frontend-prod` |
| Production | Landing | https://sprintable.ai | Cloudflare Pages |
| Production | MCP | https://mcp.sprintable.ai | Cloudflare Worker → `sprintable-mcp-prod` |
| Dev | MCP | https://dev-mcp.sprintable.ai | Cloudflare Worker → `sprintable-mcp-dev` |

### Direct Cloud Run (infra reference — asia-northeast3)

| Service | URL |
|---|---|
| Backend (prod) | https://sprintable-backend-prod-57iommnikq-du.a.run.app |
| Frontend (prod) | https://sprintable-frontend-prod-57iommnikq-du.a.run.app |
| MCP (prod) | https://sprintable-mcp-prod-57iommnikq-du.a.run.app |

## Deprecated / Decommissioned

| URL | Status | Notes |
|---|---|---|
| `https://main.d1lv1pwwa1f9wo.amplifyapp.com` | **Deprecated** | AWS Amplify — superseded by the Cloudflare clean domains above (`app.sprintable.ai`). |
| `https://sprintable.vercel.app` | **Deprecated** — scheduled for cutover | Vercel Hobby plan. Will be decommissioned after Amplify smoke is confirmed stable. See issue #44. |

## Setting APP_BASE_URL

When self-hosting, set `APP_BASE_URL` to your deployment URL so that webhook links, memo deep-links, and invite emails resolve correctly.

```bash
APP_BASE_URL=https://your-domain.example.com
```

Do **not** hardcode a deployment URL in source code — always read from `APP_BASE_URL` at runtime.
