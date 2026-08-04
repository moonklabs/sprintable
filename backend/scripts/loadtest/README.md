# story #2446 — dev capacity gate (DB axis)

Drives a high *rate* of DB-touching REST calls against `sprintable-backend-dev` using a small,
reused set of pre-seeded identities — not maximum concurrent agents/connections. See
`dev_db_capacity_test.js` header for why (08-03 incident was request-rate pool exhaustion, not
connection count; SSE concurrency caps are a separate story).

## Usage

```bash
BASE_URL=https://sprintable-backend-dev-787818285179.asia-northeast3.run.app \
CREDS_FILE=./loadtest_creds.json \
TARGET_RATE=200 \
RAMP_TIME=2m \
HOLD_TIME=30m \
k6 run dev_db_capacity_test.js
```

## `loadtest_creds.json` shape

A JSON array, each entry an already-seeded (DB-direct, not HTTP signup) agent identity scoped
to one org/project:

```json
[
  { "api_key": "sk_live_...", "org_id": "<uuid>", "project_id": "<uuid>" },
  ...
]
```

API-key auth gets its own rate-limit bucket (`Bearer sk_live_` prefix,
`backend/app/core/rate_limit.py`), so entries are reused for the whole run — no re-login, no
`/auth/token` rate-limit exposure. No `X-Org-Id`/`X-Project-Id` headers are sent — org/project
resolve from the key's own JWT `app_metadata` by default
(`get_verified_org_id`/`get_project_scoped_org_id`, `backend/app/dependencies/auth.py`); those
headers are only an optional per-request override this test doesn't need. `org_id`/`project_id`
in each entry must match what the key is actually scoped to (`enforce_body_context` rejects a
mismatch on `POST /stories`).

## Gate (§6)

`options.thresholds` in the script encode the pass/fail gate directly: `p(95)<500ms`,
error rate `<0.1%`. Run summary reports PASS/FAIL per threshold; k6 exits non-zero on any
threshold breach.
