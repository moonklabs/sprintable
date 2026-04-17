# Deployment Endpoints

Current and historical deployment URLs for Sprintable.

## Active Endpoints

| Environment | URL | Platform |
|---|---|---|
| Production (SaaS) | https://main.d1lv1pwwa1f9wo.amplifyapp.com | AWS Amplify |

## Deprecated / Decommissioned

| URL | Status | Notes |
|---|---|---|
| `https://sprintable.vercel.app` | **Deprecated** — scheduled for cutover | Vercel Hobby plan. Will be decommissioned after Amplify smoke is confirmed stable. See issue #44. |

## Setting APP_BASE_URL

When self-hosting, set `APP_BASE_URL` to your deployment URL so that webhook links, memo deep-links, and invite emails resolve correctly.

```bash
APP_BASE_URL=https://your-domain.example.com
```

Do **not** hardcode a deployment URL in source code — always read from `APP_BASE_URL` at runtime.
