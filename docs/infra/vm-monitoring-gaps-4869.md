# Cloud Run 자원만 보던 알림 · probe 전수 (story 4869 AC6)

VM 이전(dev 10-27 · prod 10-29) 뒤에도 Cloud Run 자원(`cloud_run_revision` · `run.googleapis.com/*` 지표 · `run.googleapis.com%2F…` 로그 이름 · `sprintable-backend-<env>` 서비스 이름)만 보는 것들의 목록이다.
`grep` 으로 모은 것(develop 732c4fbfc 위 · 이 PR의 가지). **옮기는 손은 각 주인** — 이 문서는 «어디가 눈먼 채인가»의 목록이다. VM 쪽 자원 모양은 `deploy/vm/ops-agent/config.yaml` 머리글(리소스 `gce_instance` ·
라벨 `compute.googleapis.com/resource_name` = VM 이름 · 로그 이름 `containers` · `labels.container`)과 같다.

| # | 어디 (file:line) | 무엇을 보나 | VM 이전 뒤 | 옮길 모양 | 주인 |
|---|---|---|---|---|---|
| 1 | `backend/monitoring/alert_policies.json` 8 (정책 «5xx Error Rate > 1%») | 지표 `run.googleapis.com/request_count` · `cloud_run_revision` · `sprintable-` 서비스 | **0 = 안 울림** (Cloud Run이 요청을 안 받음) | 가동 확인(Uptime check `/api/v2/health`) 또는 백엔드가 낸 요청 줄(`containers` · `labels.container="backend"`)에 대한 로그 기반 지표. **Caddy 접근 로그는 올리지 않는다**(클라이언트 주소 = 개인정보 · Caddyfile 29행 위 주석 «not shipped anywhere» · URI도 지워 둠) — 올릴지는 PO 결정 | 알림 주인(민 4694 줄) |
| 2 | `backend/monitoring/alert_policies.json` 54 (정책 «Cloud Run Memory > 90%») | `run.googleapis.com/container/memory/utilizations` | **0** | VM: Ops Agent 지표 `agent.googleapis.com/memory/percent_used` (`gce_instance`) + 컨테이너 케이지(RUNBOOK «Memory cages») | 알림 주인 |
| 3 | `backend/monitoring/alert_policies.json` 81 (정책 «Expo push credentials error (dev · prod)») | `resource.type="cloud_run_revision"` · `sprintable-backend-(dev|prod)` · `jsonPayload.event` | 눈멂 → 같은 파일 89~108행에 **VM 짝(정책 5번)이 이미 있음**(`gce_instance` + `resource_name`) — 이 PR의 로그가 서야 울림 | 짝이 이미 있음. Cloud Run 정책은 Cloud Run을 걷은 뒤 지워도 됨 | 민 4694 |
| 4 | `backend/monitoring/alert_policies.json` 31 (정책 «Cloud SQL CPU > 80%») | `cloudsql.googleapis.com/…` · `cloudsql_database` | dev는 Cloud SQL 걷힘(R5) · prod는 «하루 뒤 삭제» 예정 — 삭제 뒤 **0** | VM DB: Ops Agent postgres 수신기 또는 VM CPU/디스크 지표 · 백업 상태 파일 | 알림 주인 / 인프라 |
| 5 | `backend/monitoring/dashboard.json` 14 · 31 · 48 · 65 (Frontend/Backend Request Count · Cloud Run P99 Latency · Cloud Run 5xx Error Rate) | `run.googleapis.com/request_count` · `request_latencies` | **빈 차트** | 백엔드 요청 줄 기반 지표 또는 Uptime check 지연 (Caddy 접근 로그는 안 올림 — 1번 참고) | 대시보드 주인 |
| 6 | `backend/monitoring/dashboard.json` 82 · 99 · 116 (Cloud SQL CPU · Memory · Connections) | `cloudsql.googleapis.com/…` | Cloud SQL 삭제 뒤 빈 차트 | VM 지표 | 대시보드 주인 |
| 7 | `backend/scripts/setup_monitoring.sh` 7~18 (주석의 필터 3개) · 같은 파일이 위 두 JSON을 올림 | `cloud_run_revision` · `sprintable-` | 올리는 대로 위 1~6이 됨 | 위 1~6을 옮긴 JSON을 올림 | 알림 주인 |
| 8 | `infra/probe_dev_push.py` 27 · 314 (`_service_filter`) · `run services list` 호출 | `resource.labels.service_name="sprintable-backend-dev"` · Cloud Run 서비스 목록 | **서비스를 못 찾음**(민 run 42580847672) — 민이 PR 5461로 VM 필터로 고치는 중 | `gce_instance` + `resource_name` (이 PR의 로그 모양과 같음) | 민 4694 |
| 9 | `infra/probe_prod_auth_errors.py` 384 (`_service_filter`) · 562 · 730 · 739 · 745 · 793 | `logName:"run.googleapis.com%2Frequests"` · `…%2Fvarlog%2Fsystem "Starting new instance"` · `httpRequest.requestUrl`(Cloud Run 요청 로그) | **0 줄** — Cloud Run 요청 로그가 없고, VM에는 URL이 든 요청 로그가 **없다**(Caddy 접근 로그는 URI를 지우고 올리지도 않음) | 백엔드가 낸 줄(`containers` · `labels.container="backend"`)에서 오류 줄을 읽도록 다시 설계 — 어떤 줄에 URL/상태가 들어 있는지는 올라온 뒤 실제 줄로 확인 | probe 주인(인증 오류 줄) |
| 10 | `.github/workflows/serving-reality-guard.yml` 43 (`probe=prod_auth_errors` 가 `gcloud logging read` 를 여러 번 함) | 위 9번을 호출 | 9번이 0을 내면 이 가드도 «아무것도 못 봄» | 9번을 옮기면 같이 | probe 주인 |
| 11 | `deploy/vm/MCP-IN-VM.md` 27~47 | 측정 명령이 `cloud_run_revision` · `run.googleapis.com/…` | 측정 문서(과거 기록) — MCP를 VM으로 옮기기 **전** 측정이라 Cloud Run 값이 맞음 | 그대로 둠(기록) | — |

## 이 PR이 채우는 것 / 안 채우는 것

- 채움: 위 3 · 8 · 9의 «눈멂» 중 **로그를 읽는 쪽**(백엔드/프런트 컨테이너 줄이 Cloud Logging에 `gce_instance` · `containers` · `labels.container`로 선다). 실제로 서는지는 PO의 `gcloud logging read`로 dev 먼저 확인한다(RUNBOOK 「Container logs in Cloud Logging」).
- 안 채움(각 주인): 지표(1 · 2 · 4 · 5 · 6)는 로그가 아니라 **Monitoring 지표**라 Ops Agent 로그 설정으로는 안 선다 — VM 지표(`agent.googleapis.com/…`) 또는 Caddy 접근 로그 기반 지표로 옮겨야 한다.
- Caddy: 접근 로그는 JSON으로 stdout에 나오지만(`deploy/vm/Caddyfile` · `test_4796_caddy_access_log.py`) 클라이언트 주소가 들어 있어 «어디에도 올리지 않는다»고 적혀 있다 — PO 지시(백엔드 · 프런트 · caddy)와 어긋나 **caddy는 뺐다**. 올리려면 `ops-agent/config.yaml`의 정규식에 `caddy` 한 단어 + `compose.yml`의 caddy에 라벨 하나.
