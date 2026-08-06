// story #2446 — dev PgBouncer capacity gate, DB axis.
// Scope (PO 2026-08-03 redesign): the 08-03 incident was concurrent REST requests exhausting
// a small per-instance DB pool, not SSE connection count — so this test drives a high RATE of
// DB-touching REST calls with a handful of reused identities, not maximum concurrent agents.
// SSE concurrency (per-key/global caps) is a separate story; this script does not touch it.
//
// Identities: CREDS_FILE holds pre-seeded {api_key, org_id, project_id} entries (org/project
// creation bypassed — DB-direct/factory seed, not HTTP signup). API-key auth gets its own
// rate-limit bucket (backend/app/core/rate_limit.py, Bearer sk_live_ prefix), so no
// login-rate-limit concern; entries are reused for the whole run, never re-authenticated
// mid-test. No X-Org-Id/X-Project-Id headers needed — get_verified_org_id/StoryCreate resolve
// org/project from the key's own JWT app_metadata by default (backend/app/dependencies/auth.py);
// those headers are only an optional per-request override this test doesn't use.

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'https://sprintable-backend-dev-57iommnikq-du.a.run.app';
const CREDS_FILE = __ENV.CREDS_FILE || './loadtest_creds.json';
const TARGET_RATE = Number(__ENV.TARGET_RATE || 200); // requests/sec, steady-state
const RAMP_TIME = __ENV.RAMP_TIME || '2m';
const HOLD_TIME = __ENV.HOLD_TIME || '30m';
// Run 1 (2026-08-03, 200/s·5m): hit MAX_VUS=400 ceiling 14s into ramp, well before steady
// state — iteration_duration then spiraled toward the 60s default timeout while DB-pool
// telemetry (PO, same window) showed cl_active=24/sv=17 (nowhere near pool exhaustion) and
// dropped_iterations=63,573 far exceeded completed ones. That mismatch means most of the
// nominal 200/s never reached the backend at all — raising these ceilings removes k6's own
// VU-starvation as a confound before re-testing.
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 1000);
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);

// Each entry: { api_key, org_id, project_id }. See loadtest/README.md for how PO's seed
// produces this file (DB-direct — no HTTP signup, no per-org/agent SSE provisioning needed
// for this axis).
const creds = new SharedArray('rest identities', () => JSON.parse(open(CREDS_FILE)));

export const options = {
  scenarios: {
    db_rest_traffic: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: RAMP_TIME, target: TARGET_RATE },
        { duration: HOLD_TIME, target: TARGET_RATE },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export default function () {
  const cred = creds[Math.floor(Math.random() * creds.length)];
  const headers = {
    'x-agent-api-key': cred.api_key,
    'Content-Type': 'application/json',
  };

  // Mixed read/write against the DB pool per iteration — matches the incident's actual
  // failure mode (a burst of ordinary mutations exhausting a tiny per-instance pool), not a
  // single hot endpoint. GET /stories joins assignee data (heavier read than a plain list);
  // POST /stories is project-scoped so it avoids conversation-participant seeding entirely.
  const listRes = http.get(`${BASE_URL}/api/v2/stories?project_id=${cred.project_id}`, { headers });
  check(listRes, { 'stories list 200': (r) => r.status === 200 });

  const createRes = http.post(
    `${BASE_URL}/api/v2/stories`,
    JSON.stringify({
      project_id: cred.project_id,
      org_id: cred.org_id,
      title: `loadtest ${Date.now()}`,
    }),
    { headers },
  );
  check(createRes, { 'story create 201': (r) => r.status === 201 });
}
