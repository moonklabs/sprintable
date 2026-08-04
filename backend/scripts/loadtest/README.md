# story #2446 — §6 결승선 부하테스트

`sprintable-backend-dev`가 read-replica offload(#2451 A1/A2) 이후 200-300 req/s를 실제로
버티는지 증명하는 harness. Run 1(2026-08-03, `dev_db_capacity_test.js` 단독, DB axis만)의
확장이다 — 스코프를 A1/A2가 `get_read_db`로 라우팅한 엔드포인트 전체로 넓히고, 생성기
자신의 상한을 먼저 증명하는 positive-control 단계를 앞에 붙였다.

⛔ **prod 실행 금지 — 이 harness는 dev 전용**. prod 실행은 선생님의 명시적 창(window)과
go 승인 없이는 하지 않는다(BASE_URL을 prod로 바꿔서 돌리는 것도 포함 — 코드가 막진
않으니 실행 전 사람이 검토). dev 실행은 지금 자유롭게 가능.

## 구성

| 파일 | 역할 |
|---|---|
| `generator_selfcheck.js` | **Phase 1** — k6 생성기 자신이 목표 rps를 뽑을 수 있는지 무부하 엔드포인트(`GET /api/v2/ping`)로 증명 |
| `endpoint_mix_test.js` | **Phase 2** — A1/A2 read-routed 엔드포인트 믹스에 한 ramp 스테이지를 쏨(오케스트레이터가 rate별로 반복 호출) |
| `dev_db_capacity_test.js` | Run 1 원본(DB axis, `/stories`만) — 참고/단독 재현용으로 보존 |
| `ramp_expected.py` | k6 `ramping-arrival-rate` 프로파일의 기대 iteration 개수 계산(아래 「측정 방법론」 참조) |
| `run_loadtest.sh` | 오케스트레이터 — Phase 1 게이트 통과 시에만 Phase 2 ramp 스테이지를 순차 실행, 스테이지 간 kill-switch |

## 측정 방법론 — 왜 raw `iterations.rate`를 안 쓰는가

**실측으로 발견(2026-08-04)**: k6 summary export의 `iterations.rate`는 **런 전체 시간**
(램프업+hold+램프다운) 평균이다. `ramping-arrival-rate`는 램프 구간 동안 rate를 선형
보간하므로 그 구간의 평균 실효 rate는 (시작+끝)/2 — hold 구간의 목표 rate보다 항상
낮다. 실제로 `TARGET_RATE=300`(self-check rate=360, ramp 5s+hold 20s+ramp 3s)을 dev에
직접 돌린 결과, `iterations.rate`(전체평균) = 308/s로 attempted(360) 대비 86%처럼
보였지만, **achieved iteration 개수(8639)는 램프 사다리꼴 적분 기대치(8640)의 99.98%**
로 사실상 완벽했다 — raw rate 비교만 썼다면 정상 생성기를 「기아」로 오판해 kill했을
자리다.

⇒ `ramp_expected.py`가 사다리꼴 적분(`rate*(0.5*ramp_up + hold + 0.5*ramp_down)`)으로
기대 iteration 개수를 계산하고, `run_loadtest.sh`는 achieved 개수를 그 기대치와
비교한다(>=95% = pass). 「achieved rps」로 보고하는 값도 이 개수비로 스케일한
`target * achieved_count/expected_count`(ramp-adjusted) — raw 전체평균은 참고용으로만
같이 찍는다.

## Phase 1 — 생성기 self-check (positive control, ⭐가장 중요)

Run 1이 실측한 실패모드: k6 `MAX_VUS=400` 천장을 14초 만에 쳐서
`dropped_iterations=63,573`(완주 건수 압도)가 났는데, 그 순간 DB pool은 전혀 바쁘지
않았다(`cl_active=24`) — 즉 「서버가 200/s에서 캡」이 아니라 「k6 생성기 자체가 200/s를
못 뽑았다」였다. 이 오판을 원천 차단하기 위해, 본 테스트 前에 반드시 무부하 엔드포인트
(`GET /api/v2/ping` — 인증 불필요·DB 미접속)로 생성기 단독 상한을 증명한다.
`run_loadtest.sh`가 이 게이트를 통과 못 하면 **Phase 2를 아예 돌리지 않는다**.

단독 실행:
```bash
BASE_URL=https://sprintable-backend-dev-787818285179.asia-northeast3.run.app \
TARGET_RATE=300 SELFCHECK_DURATION=20s \
k6 run --summary-export=/tmp/selfcheck.json generator_selfcheck.js
```

## Phase 2 — endpoint 믹스 ramp 스테이지

`endpoint_mix_test.js`가 한 rate로 한 스테이지를 쏜다(RATE env). 엔드포인트 구성:

- **목록형 8종(A2, 60% 가중)** — `/stories` `/docs` `/tasks` `/goals` `/sprints`
  `/standups` `/meetings` `/hypotheses` (project_id 스코프, `get_read_db` 확인됨 #2451 A2)
- **가벼운 카운터/로스터/집계 10종(A1, 30% 가중)** — `/notifications/count`
  `/team-members` `/org-members` `/projects` `/activity-logs` `/glance/attention`
  `/audit-logs` `/command-center/overview` `/conversations/unread-count`
  `/event-notifications/unread-count` (`get_read_db` 확인됨 #2451 A1)
- **쓰기(10% 가중)** — `POST /stories` (원본 dev_db_capacity_test.js와 동형 — 08-03
  인시던트가 「평범한 mutation 버스트」였으므로 write 축을 완전히 빼면 그 회귀를 이
  harness가 다시 못 잡는다)

각 엔드포인트별 지연(p50/p90/p95/p99)·에러율·요청수를 `endpoint_duration_*`
`endpoint_error_rate_*` `endpoint_requests_*` 커스텀 메트릭으로 개별 노출(k6 summary는
태그별 자동 분해가 없어서 직접 추가).

⛔ **이건 A1/A2 «전체»가 아니라 seeded identity(`{api_key, org_id, project_id}`)만으로
호출 가능한 부분집합이다**(카디르 QA 2026-08-04 — 이전 README가 「A1 전체 커버」로
과대주장했던 것 정정). v1 제외:
- `GET /dashboard` — `member_id`가 필수 쿼리파라미터, seeded identity엔 없음. `GET /me`로
  bootstrap 가능(api-key 인증 시 `auth.user_id`=`team_member.id`)하나 k6 `setup()`
  단계에서 신원마다 사전 호출이 필요해 스코프 밖 — 후속 후보.
- `GET /glance/hero` — `story_id`가 필수 쿼리파라미터, seeded identity엔 특정 story
  참조가 없음(dashboard와 동일한 구조적 이유). bootstrap하려면 story를 먼저 만들거나
  목록에서 골라야 해서 스코프 밖 — 후속 후보.

## 오케스트레이터

```bash
CREDS_FILE=./loadtest_creds.json ./run_loadtest.sh
# 커스터마이즈:
STAGES="50 100 200 300" STAGE_DURATION=60s ./run_loadtest.sh
```

순서: Phase 1(self-check) 게이트 → 통과 시에만 `STAGES`(기본 `50 100 200 300`)를 순차
실행. 스테이지 사이 kill-switch — `error_rate > KILL_ERROR_RATE`(기본 5%) 또는
`p95 > KILL_P95_MS`(기본 2000ms) 위반 시 **다음(더 높은) 스테이지로 안 올라가고 즉시
중단**(exit 3). 결과는 `$OUT_DIR/summary_with_header.csv`(attempted/achieved rps·
error_rate·p50/p95/p99), 스테이지별 raw k6 summary JSON·log도 `$OUT_DIR`에 보존.

Kill-switch(스테이지 «사이», run_loadtest.sh) 자체는 2026-08-04 dev에서 실측 검증됨 —
dead credentials로 강제 error_rate=100% 상황을 만들어 exit code 3으로 정확히 중단하는
것을 확인(주입 실패 케이스로 self-verify하는 팀 관례).

### 스테이지 «내부» 방어(k6 native `abortOnFail`)

⛔**카디르 QA 2026-08-04 REQUEST_CHANGES의 핵심 발견**: 위 kill-switch는 `run_loadtest.sh`
«안에만» 있었다 — `endpoint_mix_test.js`/`generator_selfcheck.js`를 오케스트레이터 없이
`k6 run`으로 «단독 실행»하면 안전장치가 0이었다(당시 threshold는 `http_req_failed<0.05`
정보용 하나뿐, abort 없음). 이게 바로 같은 날 PO가 오케스트레이터 없이 맨손 k6로
blast해 dev를 wedge시킨 사고의 «구조적 원인» 그 자체였다.

⇒ 두 k6 스크립트에 **native `abortOnFail: true` threshold**(`http_req_failed`,
`http_req_duration p(95)`, `KILL_ERROR_RATE`/`KILL_P95_MS`와 동일 SSOT — env var 공유)를
직접 걸어, 오케스트레이터 유무와 무관하게 스크립트 자체가 급붕괴 시 즉시 멈추게 했다.

실측 검증(2026-08-04, dev): `endpoint_mix_test.js`를 존재하지 않는 URL prefix로 강제
100% 실패시켜 단독 실행 — 계획된 18초 중 **11.9초(66%)만에 자동 중단**, k6 로그에
`"thresholds ... abortOnFail enabled, stopping test prematurely"` 확인, 프로세스 종료
코드 **99**(k6의 threshold-abort 표준 코드), `--summary-export` JSON도 정상 기록됨(215
iterations) — 오케스트레이터의 후속 분석과도 호환 확인.

## 생성기가 단일 머신 CPU/네트워크에 병목이면(분산)

Phase 1이 fail하면 우선 `PRE_ALLOCATED_VUS`/`MAX_VUS`를 늘려보고, 그래도 부족하면 여러
워커(별도 머신 또는 Cloud Run Job 여러 개)로 트래픽을 분산해 각자 `RATE`의 부분집합을
쏘고 결과를 합산하는 방식으로 확장한다(이 커밋엔 분산 실행 스크립트 자체는 없음 — Phase
1이 실제로 fail할 때 필요분만 만드는 게 낫다고 판단, YAGNI).

## `loadtest_creds.json` shape

DB-direct 시더(`scripts/jobs/seed_loadtest_identities.py`) 출력. gitignore됨(실 API
key). 각 항목 `{api_key, org_id, project_id}`(org-level agent, `x-agent-api-key` 헤더로
인증 — `Bearer sk_live_`가 아님, `dev_db_capacity_test.js`/`endpoint_mix_test.js` 헤더
구현 참조).

```json
[
  { "api_key": "sk_live_...", "org_id": "<uuid>", "project_id": "<uuid>" },
  ...
]
```

재시딩은 `python -m scripts.jobs.seed_loadtest_identities`(`SEED_N` env로 개수 조절)이나,
`scripts/jobs/README.md`에 명시된 대로 이건 **PO/infra-lane**
(`gcloud run jobs execute sprintable-verify-oneoff`) — dev 크리덴셜이 만료/재구축으로
죽으면(2026-08-04에 한 번 있었음 — Run 1의 신원 20개가 401로 죽어 있었고, PO가
재시딩해 언블록함) 이 실행이 다시 필요하다. `loadtest_creds.json`은 gitignore되므로
harness 코드 자체엔 만료 여부가 기록되지 않는다 — 돌리기 전 identity 1개를 curl로
찔러 200이 오는지 먼저 확인하는 습관을 권장.

API-key 인증은 자체 rate-limit 버킷(`x-agent-api-key`, `backend/app/core/rate_limit.py`)
이라 재로그인/`/auth/token` 소모 없이 신원을 런 내내 재사용한다. `X-Org-Id`/
`X-Project-Id` 헤더는 보내지 않는다 — org/project는 키의 grant에서 서버가 직접
해소한다.

## Gate(§6)

`endpoint_mix_test.js`의 `options.thresholds`는 3중 방어 — 정보용 관측(`http_req_failed
<0.05`, abort 없음) + native abortOnFail(스테이지 «내부» 급붕괴 즉시 중단, 위 「스테이지
내부 방어」 참조) + `run_loadtest.sh`의 kill-switch(스테이지 «사이» 판정, 위
「오케스트레이터」 참조). 최종 목표 rps(200-300)에서의 p50/p95/p99·에러율은 `summary_
with_header.csv`로 보고 — 절대 임계치(200/300 어느 쪽이 결승선인지)는 선생님 확定 대기
(§6 스토리 스펙에 "200-300 잠정"으로 명시).
