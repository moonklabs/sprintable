# Sprintable Prod Adapter for Hermes Agent

Prod-backend variant of [`../hermes-sprintable`](../hermes-sprintable/README.md).
Behaviour is identical; it is a **self-contained clone** keyed entirely on
`SPRINTABLE_PROD_*` env vars so prod credentials, home channel and cron delivery
never cross with the dev plugin. Install this **in addition** to the dev plugin
when one Hermes agent must run dev and prod side by side.

> Why a clone and not a shared module? AC1 requires each plugin folder to load
> standalone from a single-folder copy (no sibling imports), so the two adapters
> cannot share a Python module. Keep behavioural changes in sync with the dev
> adapter; the inject allow-list is guarded against drift by
> `connectors/sdk/test_inject_allowlist.py`.

## Install

```bash
cp -r connectors/hermes-sprintable-prod ~/.hermes/plugins/sprintable_prod
hermes plugins enable sprintable-prod-platform      # plugin.yaml `name:`, not folder

export SPRINTABLE_PROD_AGENT_API_KEY=sk_live_...     # required (prod key)
export SPRINTABLE_PROD_API_URL=https://...           # default: prod backend

hermes gateway restart
tail -f ~/.hermes/gateway.log                        # watch [sprintable_prod] dial-out → stream open
```

## Environment variables

| Var | Req | Meaning |
|-----|-----|---------|
| `SPRINTABLE_PROD_AGENT_API_KEY` | ✅ | Prod agent API key (Bearer) |
| `SPRINTABLE_PROD_API_URL` | — | Prod backend base URL (default: prod backend) |
| `SPRINTABLE_PROD_ALLOWED_USERS` | — | Comma-sep member IDs allowed. Unset = all |
| `SPRINTABLE_PROD_ALLOW_ALL_USERS` | — | `1` = explicit allow-all |
| `SPRINTABLE_PROD_HOME_CHANNEL` | — | Default conversation_id for cron/notify (`/sethome`) |
| `SPRINTABLE_PROD_HOME_CHANNEL_THREAD_ID` | — | Thread id for the prod home channel |

Platform name: `sprintable_prod`. Cron delivery target: `deliver=sprintable_prod`.

For the channel-vs-MCP distinction, the full onboarding path and the verification
checklist, see the dev plugin's
[README](../hermes-sprintable/README.md) — everything there applies, just with
the `SPRINTABLE_PROD_*` env names and `[sprintable_prod]` log lines.
