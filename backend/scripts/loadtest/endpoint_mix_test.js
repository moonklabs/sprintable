// story #2446 — §6 결승선 부하테스트: A1/A2가 read replica로 옮긴 실 offload 경로를
// 목표 rps(파라미터, 기본 200-300 잠정 — 선생님 확定 대기)로 검증한다.
//
// dev_db_capacity_test.js(§6 Phase1, DB-axis — POST/GET /stories만)의 확장이다: 스코프를
// A1(카운터·대시보드류 일부·로스터·append-only)·A2(목록형 8종: stories·docs·tasks·goals·
// sprints·standups·meetings·hypotheses)가 실제로 get_read_db 로 라우팅한 엔드포인트
// 세트로 넓힌다 — 그게 우리가 검증할 실제 offload 경로다(PO 지시 2026-08-04).
//
// ⛔제외(v1, 후속 후보): GET /dashboard — member_id가 필수 쿼리파라미터인데
// loadtest_creds.json(seed_loadtest_identities 출력)엔 api_key/org_id/project_id만
// 있고 member_id가 없다. api-key 인증 시 auth.user_id가 곧 team_member.id라 GET /me로
// bootstrap 가능하나(app/routers/me.py), k6 setup() 단계에서 신원마다 사전 호출이 필요해
// 이 커밋 스코프 밖으로 미룬다(README에 명시).
//
// ⛔이 스크립트 «단독»으로는 목표 rps를 «달성」했는지 증명 못 한다 — attempted(설정한
// rate)와 achieved(iterations.rate) 가 다르면 그 차이가 서버 병목인지 k6 생성기
// 기아인지 이 파일만 보고는 못 가른다(Run 1이 정확히 이 함정에 빠질 뻔했다). 반드시
// generator_selfcheck.js 로 «생성기 단독 상한이 목표보다 높다»를 먼저 증명한 뒤에만
// 이 스크립트의 achieved rate 부족을 「서버 캡」으로 해석한다 — run_loadtest.sh가 이
// 순서를 강제한다. ⚠️이 파일을 오케스트레이터 없이 `k6 run`으로 단독 실행해도 아래
// `abortOnFail` threshold는 걸린다(카디르 QA 2026-08-04 지적 — 원인: 페드루가
// 오케스트레이터 없이 맨손 k6로 이 축을 blast해 dev를 wedge시킨 실사고. run_loadtest.sh의
// «스테이지 간» kill-switch만으론 스테이지 «내부»의 급붕괴를 못 막는다) — 그러나 이
// native threshold는 「명백한 붕괴」만 잡는 last-resort고, 정밀한 rate 달성 여부 판정은
// 여전히 run_loadtest.sh(+ramp_expected.py)의 몫이다.
//
// 실행(단독, 오케스트레이터 없이 한 스테이지만 보고 싶을 때):
//   BASE_URL=... CREDS_FILE=./loadtest_creds.json RATE=200 STAGE_DURATION=60s \
//     k6 run --summary-export=/tmp/stage_200.json endpoint_mix_test.js

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app';
const CREDS_FILE = __ENV.CREDS_FILE || './loadtest_creds.json';
const RATE = Number(__ENV.RATE || 100); // 이 스테이지의 목표 rps(오케스트레이터가 ramp 단계마다 바꿔 호출)
const STAGE_DURATION = __ENV.STAGE_DURATION || '60s';
const RAMP_UP = __ENV.RAMP_UP || '10s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '5s';
// run_loadtest.sh의 kill-switch와 동일 SSOT(env var 공유) — 오케스트레이터 없이 단독
// 실행해도 같은 급붕괴 기준으로 abort(카디르 QA MUST①, dev wedge 사고의 구조적 원인 봉합).
const KILL_ERROR_RATE = Number(__ENV.KILL_ERROR_RATE || 0.05);
const KILL_P95_MS = Number(__ENV.KILL_P95_MS || 2000);
// generator_selfcheck.js와 동일 근거(Run 1 VU 기아) — 이 스크립트도 넉넉하게 잡는다.
// RATE가 커지면(최대 300 예상) 필요 VU도 늘어야 하므로 RATE에 비례한 하한을 둔다.
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || Math.max(1000, RATE * 5));
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(3000, RATE * 15));

const creds = new SharedArray('identities', () => JSON.parse(open(CREDS_FILE)));

export const options = {
  scenarios: {
    endpoint_mix: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: RAMP_UP, target: RATE },
        { duration: STAGE_DURATION, target: RATE },
        { duration: RAMP_DOWN, target: 0 },
      ],
    },
  },
  // per-endpoint 관측 — 커스텀 tag로 breakdown(run_loadtest.sh가 summary JSON을
  // 엔드포인트별로 못 쪼개는 한계를 태그로 보완: k6 summary는 태그별 자동 분해를
  // 안 해줘서, 엔드포인트 이름별 http_req_duration을 별도 Trend 메트릭으로 직접 낸다).
  thresholds: {
    http_req_failed: [
      { threshold: 'rate<0.05', abortOnFail: false }, // 정보용 — 진행 중 관측용
      { threshold: `rate<${KILL_ERROR_RATE}`, abortOnFail: true, delayAbortEval: '10s' },
    ],
    http_req_duration: [
      { threshold: `p(95)<${KILL_P95_MS}`, abortOnFail: true, delayAbortEval: '10s' },
    ],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

import { Trend, Rate, Counter } from 'k6/metrics';

// 엔드포인트별 지연/에러 분해 — README 「측정: 엔드포인트별 분해」 요구사항.
const _endpointDuration = {};
const _endpointErrors = {};
const _endpointCount = {};
for (const name of [
  'stories_list', 'docs_list', 'tasks_list', 'goals_list', 'sprints_list',
  'standups_list', 'meetings_list', 'hypotheses_list',
  'notifications_count', 'team_members_list', 'org_members_list', 'projects_list',
  'activity_logs_list', 'glance_attention', 'audit_logs_list', 'command_center_overview',
  'conversations_unread_count', 'event_notifications_unread_count', 'story_create',
]) {
  _endpointDuration[name] = new Trend(`endpoint_duration_${name}`, true);
  _endpointErrors[name] = new Rate(`endpoint_error_rate_${name}`);
  _endpointCount[name] = new Counter(`endpoint_requests_${name}`);
}

function _record(name, res, expectedStatus) {
  _endpointDuration[name].add(res.timings.duration);
  _endpointErrors[name].add(res.status !== expectedStatus);
  _endpointCount[name].add(1);
  check(res, { [`${name} ${expectedStatus}`]: (r) => r.status === expectedStatus });
}

// story #2451 A2가 get_read_db로 옮긴 목록형 8종. project_id 스코프(실사용 패턴 — 「내
// 프로젝트 보드」가 org-wide 무필터보다 압도적으로 흔하다).
const _LIST_ENDPOINTS = [
  { name: 'stories_list', path: (c) => `/api/v2/stories?project_id=${c.project_id}` },
  { name: 'docs_list', path: (c) => `/api/v2/docs?project_id=${c.project_id}` },
  { name: 'tasks_list', path: () => `/api/v2/tasks` },
  { name: 'goals_list', path: (c) => `/api/v2/goals?project_id=${c.project_id}` },
  { name: 'sprints_list', path: (c) => `/api/v2/sprints?project_id=${c.project_id}` },
  { name: 'standups_list', path: (c) => `/api/v2/standups?project_id=${c.project_id}` },
  { name: 'meetings_list', path: (c) => `/api/v2/meetings?project_id=${c.project_id}` },
  { name: 'hypotheses_list', path: (c) => `/api/v2/hypotheses?project_id=${c.project_id}` },
];
// story #2451 A1이 get_read_db로 옮긴 것 중 seeded identity({api_key,org_id,project_id})
// 만으로 호출 가능한 부분집합(카디르 QA 2026-08-04 반영 — audit_logs/command_center/
// conversations/event_notifications 4개 추가). 카운터·로스터·집계는 목록형보다 가볍지만
// 고빈도라 A1 확認 당시 SHOW POOLS에서 즉시 replica hit이 뜬 자리 — 섞어야 실사용
// 트래픽 구성에 가깝다.
//
// ⛔A1 전체가 아니라 «호출 가능한 부분집합»이다(README 과대주장 정정, 카디르 QA③) —
// 제외: `GET /dashboard`(member_id 필수, 파일 상단 docstring), `GET /glance/hero`
// (story_id: uuid.UUID = Query(...) 필수 — seeded identity엔 특정 story 참조가 없어
// dashboard와 동일한 구조적 이유로 호출 불가. bootstrap하려면 먼저 story를 만들거나
// 목록에서 하나 골라야 해서 스코프 밖).
const _LIGHT_ENDPOINTS = [
  { name: 'notifications_count', path: () => `/api/v2/notifications/count` },
  { name: 'team_members_list', path: () => `/api/v2/team-members` },
  { name: 'org_members_list', path: () => `/api/v2/org-members` },
  { name: 'projects_list', path: () => `/api/v2/projects` },
  { name: 'activity_logs_list', path: () => `/api/v2/activity-logs` },
  { name: 'glance_attention', path: (c) => `/api/v2/glance/attention?project_id=${c.project_id}` },
  { name: 'audit_logs_list', path: () => `/api/v2/audit-logs` },
  { name: 'command_center_overview', path: () => `/api/v2/command-center/overview` },
  { name: 'conversations_unread_count', path: () => `/api/v2/conversations/unread-count` },
  { name: 'event_notifications_unread_count', path: () => `/api/v2/event-notifications/unread-count` },
];

export default function () {
  const cred = creds[Math.floor(Math.random() * creds.length)];
  const headers = { 'x-agent-api-key': cred.api_key, 'Content-Type': 'application/json' };

  // 가중 선택: 목록형(무거움·A2 hotspot)이 read 트래픽의 다수, 가벼운 A1 세트가 소수,
  // 쓰기가 드물게(원본 dev_db_capacity_test.js와 동형 — 실 인시던트가 「평범한 mutation
  // 버스트」였으므로 write 축을 아예 빼면 그 축의 회귀는 이 harness가 다시 못 잡는다).
  const roll = Math.random();
  if (roll < 0.6) {
    const ep = _LIST_ENDPOINTS[Math.floor(Math.random() * _LIST_ENDPOINTS.length)];
    const res = http.get(`${BASE_URL}${ep.path(cred)}`, { headers });
    _record(ep.name, res, 200);
  } else if (roll < 0.9) {
    const ep = _LIGHT_ENDPOINTS[Math.floor(Math.random() * _LIGHT_ENDPOINTS.length)];
    const res = http.get(`${BASE_URL}${ep.path(cred)}`, { headers });
    _record(ep.name, res, 200);
  } else {
    const res = http.post(
      `${BASE_URL}/api/v2/stories`,
      JSON.stringify({ project_id: cred.project_id, org_id: cred.org_id, title: `loadtest ${Date.now()}` }),
      { headers },
    );
    _record('story_create', res, 201);
  }
}
