# dev · prod 서버를 VM 한 대씩으로 — 설계 한 장 (story 4796 · AC1)

작성: 담롱 온찬 · 2026-10-27 · 상태: 초안(PO 검토용) · 코드 0. 이 문서는 «바로 짓기 위한 것»이라 결정 · 숫자 · 명령 위주로 짧게 쓴다.
상위: 호스팅 0 설계 문서(doc `d21ab190`) 6절 B안. 이 장은 그것을 dev와 prod에 각각 적용한다.

## 0. 한눈에

| | 지금 | 이 설계 후 |
|---|---|---|
| 환경마다 | Cloud Run(backend · frontend) + Cloud SQL + (pgbouncer VM) + Redis + realtime-gateway VM(MIG · 부하분산) | **VM 한 대**(e2-medium) · compose(`db` · `backend` · `frontend` · `caddy` · `migrate`) |
| 월 비용(PO 실측 · 저장소 밖 PO 문서) | 약 1,570달러 → 손으로 줄인 뒤 약 1,230달러 → 목록을 다 해도 약 960달러 | **약 85~100달러 + 송신(미측정)** — 5절. 송신이 월 약 52~66달러(≈430~550 GB)를 넘으면 150달러 목표를 넘는다 — 5절 |
| 끊기지 않는 스트림 | Cloud Run 인스턴스 평균 약 9.7대 · 24시간 과금(PO 측정) | 한 프로세스가 받는다. 인스턴스 증감 · 차가운 시작(≈31초) 없음 |
| 배포 한 번의 끊김 | 새 리비전 + 스트림 재접속 폭주 | `docker compose up -d`로 backend 교체 약 10~20초 끊김(추정 — 6절에서 dev로 잰다) |

**전제.** backend는 **한 프로세스**다(4791의 «수신자 하나» 계약이 Redis 없이 성립). 고가용성은 없다 — VM이 죽으면 서비스가 선다(복구는 7절 «죽었을 때»). 이것은 호스팅 0 설계가 이미 받아들인 선택이다.

**한 프로세스 · Redis 없음에서 달라지는 것**(코드로 확인 — 깨지는 것은 없지만 «전역 보장»이 «이 프로세스 안의 보장»으로 줄어든다): 요청 상한(`RATE_LIMIT_BACKEND=memory`)은 재시작 때 비워진다(`rate_limiter.py:77-114`) · SSE 임대는 Redis가 없으면 프로세스 지역 카운터로 열린다(`sse_lease.py:1-25`) · 작업 중 표시(presence)는 프로세스 지역, 접속 표시는 DB 하트비트로 폴백해 DB 쓰기가 늘어난다(`chat_presence.py:11-17` · `agent_gateway.py:884-890`) · 웹소켓 방은 프로세스 지역(`ws_chat.py:37-38`) · 재연결 틈새의 일시 이벤트 재전송은 꺼져 있어 틈새 이벤트가 유실될 수 있다(`SSE_TRANSIENT_REPLAY_ENABLED=false`, `sse_transient_replay.py`) · PG 수신자 하나 전제라 **두 번째 backend를 띄우면 로컬 팬아웃만 남는다**(`main.py:90-113`) — 그래서 이 설계는 «한 대»를 규칙으로 못박고, 두 번째 프로세스를 띄우는 변경은 별도 결정이다.

## 1. VM 크기

| 항목 | 값 | 근거 |
|---|---|---|
| 머신 | **e2-medium**(2 vCPU 공유 · 4 GB) · 서울(asia-northeast3) · 월 31.38달러 | 호스팅 0 설계 V2(제3자 집계 사이트 — Google 공식 가격표와 **미대조**) |
| 메모리 예산 | backend ≈ 0.45 GB(dev p95 88.1% × 512 Mi) + frontend ≈ 0.12 GB + Postgres ≈ 0.75 GB(shared_buffers 256 MB + 연결 — 구현값, 10절) + caddy 0.05 GB + OS · 캐시 → **≈ 2.0 GB, 여유 약 2 GB** | PO 표 P-measure(저장소 밖 PO 문서의 dev 실측) · 계산. **prod backend는 지금 1 Gi라 dev 수치를 그대로 쓸 수 없다 — AC2에서 prod 실측으로 다시 쓴다.** DB 쪽 연결 예산은 VM 선언의 `DB_POOL_SIZE=5` + `DB_MAX_OVERFLOW=5`(primary 최대 10) + LISTEN 1 + 워커 풀 3 = 최대 14개(처음 설계의 코드 기본값 4+1+3=8에서 선언값으로 늘림)라 `max_connections=60`(구현값)이면 넉넉하다(`config.py:40-63` · `database.py:96-115`). e2-small(2 GB)은 빠듯해 쓰지 않는다 |
| 디스크 | 부팅 20 GB + 데이터 30 GB(pd-balanced, 분리 · 이름 붙임 — RUNBOOK §4) | 데이터 디스크를 따로 두면 VM을 새로 만들어도 DB가 남는다 |
| 스왑 | 2 GB 파일 | 메모리 급증 때 OOM 대신 느려짐 |
| 외부 IP | **고정(static) 하나** — DNS A 레코드가 가리키므로(임시 IP는 정지 · 기동에 바뀐다). 열린 포트는 **80 · 443만**(SSH는 IAP로만) | 3절 |

## 2. compose 구성(`deploy/vm/compose.yml`, 저장소에 둔다)

저장소의 `docker-compose.yml`(셀프호스팅용)을 **그대로 쓰지 않고** 운영용 파일을 따로 둔다. 까닭: 셀프호스팅 파일은 `SPRINTABLE_LOCAL_DEV=1`(비밀 값 검사 끔) · `DEBUG=True` · 소스에서 빌드 · 포트 공개이고, 운영은 이미지를 받아 쓰고 비밀 값 검사가 켜져 있어야 한다.

| 서비스 | 이미지 | 메모 |
|---|---|---|
| `db` | `pgvector/pgvector:pg15`(Cloud SQL과 같은 15 — 8절 2번) | 데이터 디스크 마운트 · 포트 공개 안 함 · `max_connections=60` · `shared_buffers=256MB` · 1초 넘는 쿼리 로그(구현값 — 처음 설계의 100 · 512MB · 1536MB · 8MB에서 줄임) |
| `migrate` | backend 이미지(profile) | 배포기가 교체 **전에** `docker compose run --rm migrate`로 돌린다(`/app/scripts/migrate.sh` = `alembic upgrade heads`와 정합 검사). 실패하면 backend를 바꾸지 않는다 |
| `backend` | Artifact Registry `backend@sha256:<digest>`(배포기는 우리 프로젝트의 digest 고정 이미지만 받는다) | `DATABASE_URL`은 `db`(풀러 없음 — `DB_PGBOUNCER=false`) · `PG_LISTEN_ENABLED=true`(PG 수신자 — 실제 설정은 이것이고 `REALTIME_BACKPLANE`는 선언에 두지 않는다) · **Redis를 쓰지 않음**: `REDIS_URL` 없음 · `RATE_LIMIT_BACKEND=memory` · `EVENT_BROKER_REDIS_CONSUME_ENABLED=false`(**코드 기본값이 true** — `config.py:269-277` — 끄지 않으면 Redis 소비 루프를 찾는다) · `EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=false` · `…DISPATCH_ENABLED=false` · `*_REDIS_ENABLED=false`(팬아웃 · presence · SSE 임대) — 이름은 `cloudbuild.yaml:343-392`에서 그대로. **`SPRINTABLE_LOCAL_DEV`는 설정하지 않는다**(켜면 비밀 값 검사가 꺼진다 — 셀프호스팅 compose는 켜 둔다, `docker-compose.yml:56-60`). `K_SERVICE`가 없어도 «로컬»로 판정되지 않는다(`config.py:577-608`): 로그는 JSON, 비밀 값 검사는 fail-closed |
| `frontend` | Artifact Registry `frontend-vm@sha256:<digest>` | ⚠ **빌드 때 `NEXT_PUBLIC_FASTAPI_URL`이 박힌다**(`cloudbuild.yaml:538-550` · `apps/web/Dockerfile:51-53` · `next.config.ts:219-225` — 재작성 · 웹소켓 · 브라우저 호출 모두). 지금 값은 `run.app` 주소라 **Cloud Build 이미지를 그대로 VM에서 쓰면 계속 Cloud Run을 부른다.** VM용 빌드는 새 API 호스트(공개 주소)를 박은 별도 이미지다 — `deploy/vm/bin/frontend_build_args.py` + `build-frontend-vm.sh`(Dockerfile은 그대로, 이미 빌드 인자로 받는다). 서버 쪽 호출도 공개 API 호스트를 쓰고(VM 자기 주소로 나갔다 돌아옴), `extra_hosts`로 `backend`에 돌리는 것은 쓰지 않았다(필요하면 후속). `REALTIME_URL`은 `dev-realtime`/`realtime` 호스트. 프런트의 `/api/event-stream` 프록시는 연결을 55초로 자른다(`event-stream/route.ts:11-25`) — 이 길의 재접속 동작은 지금과 같다 |
| `caddy` | `caddy:2.8.4-alpine` | TLS 끝(Let's Encrypt 자동) · 호스트 → 서비스 대응은 3절 · 스트림 응답 버퍼링 끔(`flush_interval -1`) |
| (백업) | compose 서비스가 아니라 **호스트의 systemd 타이머** + `bin/backup.sh` | 7절. `docker exec`로 `pg_dump`, 올리기는 호스트 `gcloud storage` |

배포 환경값은 한 곳에 있지 않다: `cloudbuild.yaml` deploy-backend의 `ENV_VARS` + `backend/scripts/deploy_backend.sh`(`APP_ENV` · `CORS_ORIGINS` · `APP_URL` 등, `:103-136`) + GitHub 워크플로의 환경별 값 + `--update-secrets`로 붙는 비밀 값(`CRON_SECRET` 등 — 없으면 시작이 실패한다, `cron.py:73-84`). **정본은 살아 있는 서비스다.** 그래서 AC2의 첫 손은 PO가 `gcloud run services describe sprintable-backend-<환경> --format=yaml`에서 환경 변수 **이름**과 비밀 값 **참조 이름**(값 아님)을 뽑아 주는 것이고, `deploy/vm/env/<환경>.yaml`(이름 선언)은 그것으로 만든다. **옮길 때 키를 한 줄씩 대조하는 시험을 둔다**(빠진 키 0 · Cloud Run 전용 값은 이유와 함께 제외).

**VM에서 따로 손봐야 하는 Cloud Run 전용 동작.**
- **클라이언트 IP**: `client_ip.py:58-77`은 `X-Forwarded-For`를 **Cloud Run에서만**(`K_SERVICE`) 믿는다. VM에서는 소켓 주소 — 즉 Caddy의 컨테이너 IP — 가 쓰여 **모든 사용자가 한 요청 상한 통(bucket)에 모인다.** AC2의 코드 변경 하나: 프록시 뒤임을 선언하는 설정(예: `TRUST_FORWARDED_FOR=1`)이 켜지면 같은 규칙을 적용하고, Caddy가 `X-Forwarded-For`를 덮어쓰게 한다. BFF 경로(`EDGE_CLIENT_IP_SECRET`)는 그대로 둔다.
- **관리자 인증**: `ADMIN_OPERATOR_AUDIENCE`와 허용 목록이 없으면 503으로 닫힌다(`admin_auth.py:40-65`) — 새 API 호스트로 **값을 바꿔 다시 배선**한다(문자열 치환이 아니다).
- **CORS · 쿠키**: `CORS_ORIGINS`는 환경별 값(`deploy_backend.sh:103-136`; 코드 기본값은 `app.sprintable.ai`만, `config.py:153-158`). 쿠키 도메인은 **프런트 도메인**(prod `app.sprintable.ai`, dev는 미설정, `cookies.ts:50-57`) — API 호스트가 아니다. GCS CORS 목록(`infra/gcs-*-cors.json`)과 Cloud Build의 `run.app` origin 검사(`cloudbuild.yaml:439-440 · 485-488 · 515-516`)는 새 origin으로 함께 바꾼다.
- **준비 확인**: `/api/v2/health`는 DB `SELECT 1`만 본다. PG 수신자 · SSE가 준비됐는지는 `/api/v2/ready`가 본다(`health.py:19-71`) — 배포 확인은 **둘 다**.

## 3. 앞단 — 고정 IP + Caddy(권고) vs Cloudflare 터널

| | **B. 고정 IP + Caddy(권고)** | A. Cloudflare 터널 |
|---|---|---|
| 월 비용 | 0(Let's Encrypt) + 고정 IP 요금(≈3.65달러/월 · 미대조 — VM이 어차피 외부 IP를 쓰므로 A도 같다) | 0(터널은 무료 — 호스팅 0 설계 V1) |
| 열린 포트 | 80 · 443 세계 공개(AC6 렌즈 대상) | 0(밖으로만 연결) |
| 스트림 | **직통.** 지금 «backend 직통»과 같은 꼴(SSE) | Cloudflare를 지남 → **저장소가 이미 «CF 앞 도메인은 장수명 SSE를 버퍼링 · 차단한다»고 적어 둠**(`apps/web/public/onboarding-guide.txt:37 · :82`, `packages/cli/src/api.ts:1`) |
| 원본 IP | 노출(DNS만 쓰는 레코드) | 숨김 |
| TLS | VM 끝(Caddy 자동 갱신) | Cloudflare 끝 |

**권고 B.** 까닭은 하나이고 결정적이다: 에이전트 스트림(`/agent/stream` · SSE)이 Cloudflare 프록시 앞에서 버퍼링 · 차단된다는 기록이 저장소에 있다(웹소켓에 대한 기록은 없다 — 직통이면 제한이 없다는 것은 SSE 쪽 근거이고 웹소켓은 AC2에서 잰다)(그래서 지금도 에이전트는 `run.app` 직통을 쓴다). 터널은 그 프록시를 지나므로 같은 병을 되풀이할 수 있다 — 터널이 이 병을 피하는지는 **재 보기 전에는 모른다**. 터널(A)은 UI 호스트(`app`) 한 곳에만 선택지로 남겨 둔다(열린 포트를 줄이려는 경우). 열린 포트 80 · 443의 위험은 Caddy(메모리 안전 언어 · 자동 TLS) · 방화벽(80 · 443만) · SSH는 IAP로만 막고, AC6에서 까디르 렌즈를 받는다.

**호스트 대응(도메인은 그대로 둔다).** 모두 **고정 IP를 가리키는 A 레코드**이고, API · realtime 호스트는 **DNS 전용(회색 구름)**, UI 호스트(`app` · `dev-app`)는 **Cloudflare 프록시 유지(주황 · SSL Full strict)**. Caddy가 호스트별로 나눈다.

| 호스트(dev / prod) | 지금 | VM 후 |
|---|---|---|
| `dev-app` / `app`.sprintable.ai | Cloud Run frontend(CF 앞) | Caddy → `frontend:3000`. **UI는 CF 프록시를 유지한다**(PO 결정 — SSL 모드 Full strict) |
| `dev-realtime` / `realtime`.sprintable.ai | GCE 게이트웨이(부하분산 · 직통) | Caddy → `backend:8000`(SSE · 웹소켓) |
| **API 주소**(지금 `*.run.app` «backend 직통») | Cloud Run backend | **새 호스트 필요**: `dev-api` / `api`.sprintable.ai → `backend:8000` |

### run.app 주소를 쓰는 곳 — 원칙 «앱 · 폰 · MCP가 바뀌지 않게»와 부딪히는 자리

Cloud Run을 걷으면 `*.run.app` 주소가 사라진다. 저장소에서 읽은 소비자(시험 파일 제외, 주석 포함 파일 수):

1. **사용자에게 안내하는 글**: `apps/web/public/{connect-guide.ko,connect-guide.en,onboarding-guide}.txt` — «API base URL은 backend 직통 run.app 주소» (SSE가 CF 앞에서 안 되므로 필수라고 적음). 이 글이 새 API 호스트를 말하게 고쳐야 한다.
2. **기본 주소가 박힌 코드**: `packages/cli/src/api.ts`(+ README) · `packages/fakechat/server.ts` · `connectors/**` 19개 파일(파이썬 SDK · opencode · openclaw · gemini · grok · cursor · pi · hermes · codex).
3. **배포 설정**: `cloudbuild.yaml`의 `_FASTAPI_URL` · `_BACKEND_URL`(Google 로그인 리다이렉트 주소) · `_ADMIN_OPERATOR_AUDIENCE` · 프런트의 GCS CORS 허용 목록(`infra/gcs-*-cors.json`의 frontend `run.app` 둘).
4. **사람 손**: Google · Apple 로그인 콘솔의 리다이렉트 주소 · 각 연동(GitHub · Toss 등)에 등록된 콜백 주소 — **목록은 댄(연동)이 가진다**.
5. **각 레인 맥의 MCP 설정**(`SPRINTABLE_API_URL` — 이 세션의 MCP 서버도 `run.app` 주소를 쓴다).
6. **남는 Cloud Run 서비스와 backend 주소를 서로 아는 곳**: 호스팅 MCP(`sprintable-mcp-*` — `SPRINTABLE_API_URL` · `MCP_PUBLIC_URL` · `MCP_ALLOWED_HOSTS`, `backend/sprintable_mcp/{README.md,config.py,server.py}` · `cloudbuild.yaml:1002-1053`) · office-converter(`office_conversion.py`, `cloudbuild.yaml:53-62 · 786-849`) · support-gateway의 backend 콜백(`support-gateway/app/config.py:74-79`, `cloudbuild.yaml:1136-1145`). 이 셋은 **Cloud Run에 남기되 최소 0**(월 비용 ≈ 0)으로 두고 주소만 새 호스트로 바꾼다 — 걷는 대상은 backend · frontend · Cloud SQL · Redis · pgbouncer · 게이트웨이다.
7. **backend가 만들어 주는 주소**: 에이전트 온보딩 응답(`agent_onboarding_config.py:254-271`) · 배포 스크립트(`deploy_backend.sh` · `deploy_frontend.sh`의 URL · CORS · 쿠키) · `docs/deployment-endpoints.md`.
8. 데스크톱 앱 · 폰 앱: 서버가 내려 주는 주소를 쓰는 곳은 안 바뀐다(`base()`); 박힌 곳은 mobile 저장소라 이 문서에서는 못 읽었다.

처리: 새 API 호스트를 먼저 만들고(DNS 전용 A 레코드), 소비자를 새 호스트로 옮긴 뒤(코드 PR + 사람 손), **Cloud Run 걷기(AC3)는 소비자 목록이 비었을 때만** 한다. 옛 주소를 잠시 살려 둘 «가림막»(Cloud Run 최소 0의 리다이렉트 서비스)은 선택지로 두되 스트림은 못 받는다 — 소비자 이전이 끝나면 걷는다.

## 4. 배포 길과 비밀 값

**배포(받아오는 쪽).** CI가 VM에 접속하지 않는다.

1. develop/main 병합 → 지금처럼 Cloud Build가 이미지를 빌드해 Artifact Registry에 올린다(VM용 프런트는 `frontend-vm` 따로, 모두 **digest로 고정**해 `desired.json`에 적는다).
2. 같은 파이프라인의 마지막 스텝이 번들(`bin/make_bundle.py`)을 먼저 올리고 «원하는 sha»를 `gs://<환경>-deploy/desired.json`에 **마지막으로** 쓴다(되돌리기 = 이 파일을 옛 것으로). *이 `cloudbuild.yaml` 스텝은 아직 없다 — 민의 과금 방식 PR 뒤에 넣는다(10절). 그 전에는 PO가 RUNBOOK §5대로 손으로 올린다.*
3. VM의 `sprintable-deploy.timer`(60초)가 그 파일을 읽어 다르면: 묶음(번들) 받기(체크섬 대조) → 이미지 받기 → `migrate` → `backend` · `frontend` 교체 → Caddy 재적재 → `/api/v2/health` **와** `/api/v2/ready` 통과 확인 → 결과를 `gs://<환경>-backups/status/<환경>/<시각>.json`에 씀(새 객체만 만든다). 교체 뒤 실패하면 **이전 sha로 되돌리고** 실패를 기록한다. 되돌려도 **마이그레이션은 되돌아가지 않는다**(이전 이미지가 새 스키마로 동작해야 한다 — 확장 먼저 · 정리는 다음 배포).
   VM은 배포 버킷을 **읽기만** 한다(쓰기는 Cloud Build 서비스 계정뿐) — 침해된 VM이 자기가 돌릴 것을 바꿀 수 없다. 반대로 배포 버킷에 쓸 수 있는 쪽은 VM에서 root로 돌 것을 정하므로, 배포기는 **우리 Artifact Registry 프로젝트의 이미지만** 받고, 묶음의 `compose.yml`은 알려진 다섯 서비스 · 특권 옵션 없음 · 데이터 폴더와 Caddyfile 외 마운트 없음 · 80/443만 공개일 때만 받아들인다(코드 `deploy/vm/bin/deployer.py`).
4. 배포 지연 ≤ 60초 + 이미지 받기. 끊김은 backend 교체 구간(약 10~20초 — 추정).

**비밀 값.** VM 전용 서비스 계정 `sprintable-vm-<환경>`(권한: Secret Manager 접근자 — 이 환경 비밀만 · Artifact Registry 읽기 · 배포 버킷 · 로그 쓰기). 배포기가 **매 배포마다** 메타데이터 토큰으로 Secret Manager를 읽어, `docker compose` 명령의 **프로세스 환경**으로만 넘기고(파일에는 이름만 — 값 0) compose가 이름으로 받아 컨테이너에 준다. 우리가 쓰는 파일(.env · 통과 파일 · 상태 · 로그)에는 값이 없다. 다만 **Docker는 컨테이너 환경을 자기 설정(`/var/lib/docker`, root 전용)에 보관**한다 — 모든 컨테이너가 그렇고, 그래서 «디스크에 안 남는다»는 이 문서 초안의 문구는 틀렸다. VM의 root는 IAP 전용 SSH + OS Login이 정한다. 레지스트리 로그인은 이미지를 받는 동안만 있고(`docker logout`), 명령 출력은 기록 전에 비밀 값이 가려진다. 지금 realtime-gateway의 «부팅 1회» 방식(로테이션 후 15시간 옛 값을 쥔 사고, story #3616)과 달리 **배포마다 다시 읽는다** — 로테이션 절차는 «배포 파일을 다시 쓴다» 한 줄이다. DB 비밀번호는 새로 만든 값(`DB_PASSWORD_VM_<환경>`, 영숫자 16자 이상 — 접속 URL에 들어가므로 `openssl rand -hex 24`)이다. 살아 있는 서비스의 **비밀 아닌 값**은 PO가 `gcloud run services describe`에서 뽑은 파일(`/etc/sprintable/private-plain.json`, root 0600, 서비스별)로 한 번 넣고, 비밀인 값은 지금과 같은 Secret Manager 항목을 읽는다 — 어느 이름이 어느 쪽인지는 `deploy/vm/env/<환경>.yaml`이 정본이고, 시험이 «살아 있는 이름 하나도 빠지지 않음 · 두 곳에 안 있음»을 고정한다.

**VM 서비스 계정이 가져야 할 것(Cloud Run backend 서비스 계정과 동등).** 지금 backend의 서비스 계정 권한을 그대로 읽어(명령은 RUNBOOK §2) 옮긴다: Secret Manager 접근자(이름 목록은 위 선언에서) · Artifact Registry 읽기 · `GCS_*_BUCKET`에 적힌 버킷 · Vertex AI/Gemini · Firebase · 로그/지표 쓰기. 배포 버킷은 읽기만, 백업 버킷은 **객체 만들기 + 읽기**만(덮어쓰기 · 삭제 불가 — 침해된 VM이 백업을 지우지 못한다).

## 5. 비용 — 전 → 후(가격표 × 사용량)

| 줄 | 월(달러) | 상태 |
|---|---|---|
| e2-medium × 2(dev · prod) | 62.76 | 제3자 집계(공식 미대조) |
| 디스크 50 GB × 2(부팅 20 + 데이터 30 — RUNBOOK §4, pd-balanced, 서울) | 13~26 | 두 집계 사이트가 0.13 / 0.26달러·GB로 갈림 — 대조 필요 |
| 고정 외부 IP 2 | 7.30 | 시간당 0.005달러 가정 — 미대조 |
| 백업 저장(GCS · 14일) | ≈ 1~2 | DB 크기 미측정(가정 2 GB) |
| TLS(Caddy · Let's Encrypt) | 0 | — |
| 로그 · 모니터링 | 0 | Cloud Logging 월 50 GiB 무료 안(추정) |
| **합(송신 제외)** | **≈ 84~98** | |
| 인터넷 송신 | **미측정** | prod는 4788 전 하루 약 44 GB였다. **월 150달러 목표의 남는 몫은 약 52~66달러(고정비 84~98달러의 두 끝) → 서울 기준 0.12달러/GB 가정 시 월 430~550 GB(하루 14~18 GB, dev+prod 합)** |

**읽기.** 월 150달러 아래가 되려면 송신이 하루 14~18 GB 이하여야 한다. 4788(재연결마다 전체 이력 재전송 제거) 뒤의 실제 송신은 아직 안 쟀다 — **AC2의 첫 일은 dev · prod 현재 송신량을 청구서에서 읽는 것**(PO). 이 칸이 비면 «150달러 미만»을 선언하지 않는다.

## 6. dev 이전 — 순서와 끊김

AC2(올림 · 옮김) → AC3(전환 · 걷기). 손은 PO가 하고 나는 명령 · 되돌리기 · 시간을 준다.

1. **VM 만들기**(PO · 명령은 `deploy/vm/RUNBOOK.md`): 서비스 계정 · 버킷 · VM · 데이터 디스크 · 고정 IP · 방화벽(80 · 443).
2. **DB만 먼저 올려 옮김**(RUNBOOK §6~7): `bootstrap.sh` → VM에서 `deployer.py --db-only`(db만 기동) → Cloud SQL dev → `pg_dump -Fc` → `restore.sh`(체크섬 · 읽힘 · 테이블 데이터 확인 뒤 `pg_restore`) → **행 수 대조**(`deploy/vm/rowcounts.sh`, 두 쪽 `count(*)` diff). 빈 DB에 먼저 앱을 올려 스키마를 만든 뒤 복원하는 순서는 쓰지 않는다.
3. **배포 타이머 켬**: `desired.json`을 올리고 `sprintable-deploy.timer`를 켜면 배포기가 `migrate`(덤프의 alembic 버전에서 head까지) → 교체 → `/api/v2/health` + `ready`. 인증서는 호스트 이름이 VM을 가리킨 뒤에야 나오므로(RUNBOOK §8) 전환 전에는 `curl --resolve`로 시험한다.
4. **레인 바퀴**(AC2): 로그인 · 대화 · 데스크톱 릴레이 · MCP · 폰 지시가 새 VM에서 통과.
5. **전환**(PO 예고 후): 쓰기를 멈추고(Cloud Run dev 문을 `--ingress internal`로 닫고 스케줄러 일시중지 — RUNBOOK §7) **최종 덤프 → 복원 → 호스트 대응 바꿈**. **끊김 = 덤프 + 복원 + 확인**. 추정식: 덤프 ≈ DB크기 ÷ 50 MB/s, 복원 ≈ DB크기 ÷ 20 MB/s(+ 인덱스) — **DB 크기는 PO에게 묻는다**. 예: 2 GB면 덤프 약 1분 + 복원 약 2분 + 확인 → **약 5~10분**(추정).
6. **하루 지켜봄** → Cloud Run dev · Cloud SQL dev · Redis dev · pgbouncer-dev · realtime-gateway-dev(VM · 부하분산 · IP)를 걷는다. 줄마다 되돌리기 한 줄은 RUNBOOK에 둔다.
7. **되돌리기(전환 뒤 하루 안)**: 호스트 대응을 Cloud Run으로 되돌린다. 그동안 VM에 쓰인 데이터는 `pg_dump` → Cloud SQL 복원(역방향 명령 준비)으로 옮기거나, dev라면 하루치 손실을 받아들인다(PO 결정).

prod는 dev가 하루 무사한 뒤 같은 순서로, **사람이 적은 시각 · 선생님께 먼저 한 줄**.

## 7. DB 백업과 복원 · 로그 · 죽었을 때

- **백업**: 매일 `pg_dump -Fc` → `gs://<환경>-backups/db/db-<환경>-<시각>.dump` + `.sha256`(14일 보관, 수명주기 삭제). 올리기 전에 `pg_restore --list`로 읽히는지 · 테이블 데이터가 있는지 · 크기를 확인하고, 실패하면 올리지 않고 단위가 실패한다. 추가로 데이터 디스크 일일 스냅샷(7일). **RPO 24시간**(Cloud SQL의 시점 복구보다 약하다 — 알고 받아들이는 값이다. 필요하면 WAL 보관을 후속으로).
- **복원 실측**: 첫 백업을 **빈 임시 DB에 복원**해 시간 · 행 수 대조를 기록한다(AC2에 포함 — 복원해 보지 않은 백업은 백업이 아니다). 같은 일을 `restore-check.sh`가 매주 한다(`restore_seconds=… tables=… rows=…` 한 줄).
- **로그**: 컨테이너 로그는 json-file(10 MB × 5 회전) + Ops Agent가 Cloud Logging으로(앱은 이미 JSON 로그). 알림: 가동 확인(`/api/v2/health`) + 디스크 85% · 메모리 90%.
- **죽었을 때**: 자동 재시작(`restart: unless-stopped` · systemd) → VM 정지면 MIG 없이 `gcloud compute instances start`(PO 손 · 목표 5분). VM이 사라지면 새 VM 만들기 + 데이터 디스크 붙이기(디스크가 남아 있는 한 DB 보존) — RUNBOOK에 명령.

## 8. PO 답(2026-10-26 · 입력 `~/.sprintable-shared/po/4796-inputs/`) 과 남은 위험

**받은 답.**
1. **송신량(24시간)**: backend-prod **47.5 GB**, dev 합쳐 약 **2.3 GB**. prod 몫은 거의 다 플러그인 재연결의 꼬리 재전송 — 댄의 4788 AC2가 서버 쪽 뿌리를 고치는 중이다. 그것이 들어가기 전의 값으로는 5절의 송신 예산이 깨지므로 «150달러 아래»는 **선언하지 않는다**(4788 AC2 이후 실측으로 다시 계산).
2. **Cloud SQL**: 둘 다 POSTGRES_15 · db-g1-small · prod 20 GB / dev 10 GB SSD → `pgvector/pgvector:pg15` 그대로, 덤프-복원은 같은 메이저 버전.
3. **DNS**: Cloudflare. 정한 것 — API · realtime 호스트는 VM 고정 IP로 **DNS 전용** 레코드(prod는 `api.sprintable.ai` 신설, dev는 `dev-api`를 전환 때 CF 프록시 CNAME에서 DNS 전용으로). 호스팅 MCP(`dev-mcp` / `mcp`)는 **Cloud Run에 그대로 두고** 그쪽 backend 주소만 새 API 호스트로 바꾼다(RUNBOOK §8·§9), UI 호스트(`app` · `dev-app`)는 **VM 고정 IP를 가리키되 CF 프록시를 유지**(주황 · SSL 모드 Full strict), 레코드 손은 PO가 전환 때.
4. **환경 변수 이름 · 비밀 참조**: `env-names.txt`(6개 서비스) → `deploy/vm/env/live-names.{dev,prod}.txt`에 이름만 사본으로 두고 시험이 대조.
5. **로그인 콘솔 · 연동 콜백**: 도메인을 그대로 두면 sprintable.ai 쪽 콜백은 안 바뀐다. 따로 봐야 할 것은 «run.app 주소를 가리키는 곳» — 아래 **부록 A**.

**남은 위험.**
1. 송신량(위 1) — 4788 이후 실측 전에는 비용 목표 미선언.
2. 가격표 대조: e2-medium · 디스크 · IP 요금을 Google 공식 가격표로(내 도구로는 못 읽었다).
3. mobile 저장소의 desktop 앱 · 폰 앱이 `run.app`을 박아 쓰는 곳(이 문서에서는 읽지 못했다 — 민 · 디디 영역).
4. **열린 포트 80 · 443**(AC6 렌즈): 방화벽은 80/443 전체 + 22는 IAP 대역만, DB · backend · frontend는 compose 망 안에서만(시험이 «caddy만 공개»를 고정).
5. **첫 인증서**: Caddy는 호스트 이름이 VM을 가리킨 뒤에야 인증서를 받는다 — DNS 전환 직후 짧은 인증서 오류 구간이 있다(공지 항목).
6. **VM용 프런트 이미지**: `NEXT_PUBLIC_FASTAPI_URL`이 빌드 때 박히므로(2절) Cloud Build가 VM용 이미지를 따로 굽는다(AC2 후속 — cloudbuild.yaml, 민의 과금 PR과 겹침 확인 뒤).
7. **client_ip**: VM에는 `K_SERVICE`가 없어 `X-Forwarded-For`를 안 믿으면 모든 사용자가 Caddy 주소 하나로 세어진다 → `TRUST_FORWARDED_FOR`(기본 꺼짐) 설정을 **구현해 병합했다**(PR #5264, `X-Forwarded-For`가 여러 줄이면 마지막 줄의 마지막 칸) · VM 환경 선언은 이미 `true`로 켠다(`env/dev.yaml`) · 단 이 코드가 dev/prod Cloud Run에 **배포돼 있어야** VM 전환이 안전하다(PO 배포 중). backend는 compose 망 밖으로 열리지 않으므로 이 값을 켠 프로세스의 상대는 Caddy(와 같은 망의 frontend)뿐이다.
8. 단일 프로세스 · 단일 VM — 고가용성 없음(7절 «죽었을 때»), 마이그레이션은 롤백되지 않음(4절).

## 9. 다음 일(AC2)의 산출물 — 저장소에 두는 코드

`deploy/vm/`(AC2 — 실제로 만든 꼴): `compose.yml` · `Caddyfile` · `env/{dev,prod}.yaml`(+ 살아 있는 이름 사본과 대조 시험) · `bin/render_env.py` · `bin/deployer.py` · `bin/make_bundle.py` · `bin/bootstrap.sh` · `bin/{backup,restore,restore-check,rowcounts}.sh` · `systemd/*` · `README.md` · `RUNBOOK.md`(PO용 gcloud 명령 · 줄마다 되돌리기). cloudbuild.yaml에는 «원하는 sha 쓰기» 스텝 하나(민의 과금 방식 PR과 파일이 겹치는지 먼저 본다).


## 부록 A. `run.app` 주소를 가리키는 코드 · 설정(2026-10-27 저장소 읽기, develop 기준)

원칙: 사용자 접점 도메인(`app` · `dev-app` · `mcp` · `realtime` …)은 그대로이고, **백엔드를 `…run.app`으로 직접 부르는 곳**만 전환 때 새 API 호스트(`dev-api.sprintable.ai` · `api.sprintable.ai`)로 바뀐다. «바꾸는 손» 구분: **코드(PR)** = 담롱군 후속 · **서비스 설정** = PO(gcloud) · **콘솔/외부** = PO.

| # | 어디 | 무엇이 박혀 있나 | 바꾸는 손 |
|---|---|---|---|
| 1 | `apps/web/public/{connect-guide.en.txt, connect-guide.ko.txt, onboarding-guide.txt}` | 사용자·에이전트에게 보이는 안내문이 backend-prod/dev `run.app`을 «직통(SSE 필수)»로 안내(`onboarding-guide.txt:37·40·82·228`) | 코드(PR). 새 API 호스트는 DNS 전용이라 «CF 앞단 금지» 문구도 함께 고친다 |
| 2 | `backend/app/services/agent_onboarding_config.py:268` · `host-rule-vectors.json:153-154` | 온보딩 설정 생성기가 «직통 run.app이어야 한다»고 규정, 호스트 규칙 시험 벡터에 dev run.app | 코드(PR) + 시험 벡터 |
| 3 | `packages/cli/src/api.ts:1-2` · `packages/cli/README.md:44` | CLI 기본 주소 = backend-prod run.app | 코드(PR) — 배포된 CLI는 구버전이 옛 주소를 계속 씀 → **옛 run.app 주소는 걷기 전에 전환 기간을 둔다** |
| 4 | `packages/fakechat/server.ts:22` | dev run.app 기본값 | 코드(PR) |
| 5 | `connectors/sdk/sprintable-sse.ts:12·60` · `sprintable_sse.py:15·39` · `connectors/connectors-pkg/sprintable_connectors/{codex,cursor,gemini,grok,pi,sdk}.py` · `connectors/*-sprintable/*`(커넥터 패키지 11개 파일(connectors 전체 19개 파일)) | 에이전트 커넥터의 기본 backend 주소 = dev run.app | 코드(PR, 댄 영역과 겹침 — 확인 후) |
| 6 | `backend/sprintable_mcp/{README.md, .mcp.json.example, config.py, server.py}` · `backend/scripts/deploy_mcp_{dev,prod}.sh` | 호스팅 MCP의 `SPRINTABLE_API_URL`(backend run.app), `MCP_ALLOWED_HOSTS`에 run.app | 서비스 설정(PO) + 코드(PR) |
| 7 | `backend/scripts/{deploy_backend.sh:63·85, deploy_frontend.sh, deploy_realtime_gce.sh:127·199, verify_gcp_migration.sh, jobs/verify_grant_only_story_assign.py}` | 배포·검증 스크립트의 기본 URL / CORS 출처 | 코드(PR) — VM 전환 뒤 이 스크립트 자체가 쓰이지 않게 되는 것은 정리 대상 |
| 8 | `.github/workflows/cloud-build.yml:68·275·291·294·456-457` · `cloudbuild.yaml:17·23·34·62·249·439·485·515` | 배포 파이프라인의 backend/frontend/support-gateway/office-converter run.app 주소(`_FASTAPI_URL` · `_BACKEND_URL` · `_ADMIN_OPERATOR_AUDIENCE` 포함) | 코드(PR) — **민의 cloudbuild.yaml 과금 PR과 겹치는 파일**이라 순서 확인 |
| 9 | `infra/gcs-{attachments,avatars,channel-media}-cors.json` | CORS 허용 출처에 frontend dev run.app | 버킷 설정(PO, `gcloud storage buckets update --cors-file`) |
| 10 | `support-gateway/app/config.py:75` · `apps/web/src/lib/project-context-client.ts:122` | 주석/예시 수준(support-gateway의 backend 콜백 URL은 서비스 환경 변수) | 서비스 설정(PO) |
| 11 | **저장소 밖**: 각 레인 Mac의 MCP `SPRINTABLE_API_URL`, 데스크톱·폰 앱 설정, Google·Apple·GitHub 등 로그인 콘솔·연동 콜백(댄의 목록) | run.app을 직접 가리키는 것만 | PO(전환 때), 댄의 콜백 목록과 합쳐 분배 |

읽은 범위의 한계: 시험 파일(`backend/tests/**` 11개)은 주소를 예시로만 쓴다(전환 때 함께 맞출 대상이지만 동작 의존은 아님). mobile 저장소는 읽지 못했다.


## 10. 구현과의 대조(5266 병합 뒤 · 2026-10-27)

이 문서는 AC1 설계 한 장이고, 실물은 `deploy/vm/`(PR #5266)와 그 **RUNBOOK이 우선**한다. 본문의 겹치는 줄은 위처럼 고쳤고, 설계와 실물이 갈린 곳은 아래와 같다.

| 설계 | 실물 | 까닭 |
|---|---|---|
| Postgres `max_connections=100` · `shared_buffers=512MB` | 60 · 256MB | 연결 예산이 코드상 8개라 줄여 메모리 여유를 늘림 |
| 이미지 `backend:<sha>` 태그 | `@sha256:<digest>` 고정 | 태그는 나중에 옮겨질 수 있어 롤백이 «그때 그 이미지»가 아니게 됨 |
| 번들의 `compose.yml`이 곧 실행 정의 | VM에 bootstrap이 설치한 사본과 **문서로 정확히 같을 때만** 받음 | 번들은 VM에서 root로 도는 정의라 compose 변경은 사람 손(bootstrap 재실행)을 거치게 함 |
| 비밀을 tmpfs 파일에 | `docker compose` 프로세스 환경으로만(파일엔 이름만) + Docker의 root 전용 설정 | 4절 정정 |
| `backup` compose 서비스 | systemd 타이머 + 호스트 스크립트 | 컨테이너에 gcloud를 넣지 않으려고 |
| 쓰기 중지 «점검 상태» | `--ingress internal` + 스케줄러 일시중지 | Cloud Run 최소 인스턴스는 0이 불가 |
| 배포 상태 `status.json` 덮어쓰기 | `backups` 버킷에 새 객체로만(`status/<환경>/<시각>.json`) | VM이 버킷 객체를 덮어쓰거나 지우지 못하게 |
| (설계에 없음) | 도중에 죽은 swap은 `pending.json`으로 표시해 다음 실행이 desired.json을 읽기 전에 정리 · 캐시된 release 폴더는 번들 체크섬 표식이 맞을 때만 재사용 · 손상된 상태 파일은 «알 수 없음»으로 두고 서비스를 멈추지 않음 | 코드 검수에서 나온 틈 |
| (설계에 없음) | **병합됨**: `bin/check_live_names.py`(전환 전 라이브 서비스 이름 대조) · `bin/lib.sh` · `bin/restore.sh`. **아직 PR**(미병합): `bin/frontend_build_args.py` + `build-frontend-vm.sh`(PR #5281) · `env/prod.yaml` + 환경별 JWT 비밀(PR #5283) | AC2 마무리 · AC4 준비 |

**아직 안 한 것**: `cloudbuild.yaml`의 «번들 올림 + desired.json 쓰기» 스텝(민의 과금 방식 PR 뒤 — PO 지시) · 실제 VM에서의 측정(compose 기동 · 인증서 · 덤프-복원 시간 · 행 수 일치 · 레인 바퀴 · 첫 VM에서 세는 주소 확인) · 비용 목표 선언(4788 뒤 송신 실측 前이라 안 함).
