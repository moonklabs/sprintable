from pydantic_settings import BaseSettings, SettingsConfigDict

# E-LOOP-LEDGER P1: gemini-embedding-001 @ output_dimensionality=768(파운데이션 crux 확정,
# 2026-07-01) — app.models.embedding.Embedding.embedding(vector 컬럼)과 embedding_client.py
# 양쪽이 이 단일 상수를 참조한다(중복 선언 제거, PO 지시 2026-07-02). 배포별로 달라질 값이
# 아니라(모델 자체를 바꾸는 결정) env-overridable Settings 필드가 아닌 plain 상수로 둔다.
EMBEDDING_DIMENSION = 768


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")

    # Database
    # Cloud SQL Auth Proxy 연결 예시:
    #   postgresql+asyncpg://sprintable:PASSWORD@127.0.0.1:5433/sprintable
    # Cloud SQL Unix socket 연결 예시 (Cloud Run 등):
    #   postgresql+asyncpg://sprintable:PASSWORD@/sprintable?host=/cloudsql/sprintable:asia-northeast3:sprintable-dev
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"
    # ee7794eb ③: DB_PGBOUNCER on 時 DATABASE_URL 은 PgBouncer(transaction-mode) 를 가리키는데, pg_pubsub
    # raw LISTEN/NOTIFY 는 transaction-mode 비호환(연결이 statement 마다 반납돼 LISTEN 상태 소실) → **direct
    # Cloud SQL URL 별도**로 우회. 미설정 시 database_url 폴백(non-PgBouncer 환경). on+미설정 = startup
    # fail-closed(pg_pubsub.check_listen_config·main lifespan).
    database_url_direct: str = ""

    # Cloud SQL (D-S1: Phase D GCP 인프라)
    cloud_sql_instance_dev: str = "sprintable-494803:asia-northeast3:sprintable-dev"
    cloud_sql_instance_prod: str = "sprintable-494803:asia-northeast3:sprintable-prod"

    # E-LOOP-LEDGER P1-S2: Vertex AI 임베딩(gemini-embedding-001) — cloud_sql_instance_*와 동일
    # GCP project/region(sprintable-494803·asia-northeast3) 기본값. ADC로 인증(신규 크리덴셜 관리 0,
    # ga4_client.py/gcs.py와 동일 패턴).
    gcp_project_id: str = "sprintable-494803"
    vertex_ai_location: str = "asia-northeast3"

    # E-INFRA S2 + ee7794eb: DB 커넥션 풀 **rollout-safe** right-size (env DB_POOL_SIZE/DB_MAX_OVERFLOW override).
    # ⚠️ 배포 rollout 時 old+new 리비전이 **동시 점유(2×)** — steady 산식만 쓰면 배포 중 max_connections
    #    초과(2026-06-29 dev TooManyConnections·#1766 rollout 전요청 500). **인스턴스당 실 커넥션은 pool
    #    밖의 raw 연결까지** 포함해야 한다(까심 적출): pg_pubsub.listen_loop = raw asyncpg **상시 1개**(pool
    #    미점유). (l2_worker 는 engine.connect→pool 내·추가 0.) → **per_instance = (pool+overflow) + RAW(1) = 5.**
    #    rollout-aware 산식: **2 × maxScale × ((pool+overflow) + RAW) + admin/migration headroom ≤ max_connections.**
    #   ① 앱 최소요구(실측): pool+overflow ≥ 4 (total 3 이면 send_message pool_timeout). ∴ pool 3/1=4 고정(밑으로 불가).
    #   ② dev(f1-micro ~25·maxScale 실측 10→PO **1** 적용 rev 01240-hkc): 2×1×5+5 = 15 ≤ 25 (여유 10).
    #      (maxScale 2 면 25/25 한계·1 로 여유 확보. 10 이면 2×10×5+5=105≫25 → pool 4 단독 불가·maxScale↓ 필수.)
    #   ③ prod(g1-small 100·maxScale **실측 필수**): 2×10×5+20=120 > 100(가정 10이면 초과). 안전 상한 maxScale≤8
    #      (2×8×5+20=100·여유 0). **prod 승격 前 PgBouncer(durable·연결 decouple) 또는 tier↑ 필수**(maxScale 캡만으론 0 headroom).
    # ⚠️ 향후 always-on LISTEN/raw 연결 추가 시 RAW 카운트 ++ 동반(산식 누락 = 이번 false-PASS 재발).
    # ⚠️ --concurrency=80 과 별개: 풀은 DB op 점유 구간만 잡고 즉시 반납·초과분 pool_timeout 대기(실패 아님).
    db_pool_size: int = 3
    db_max_overflow: int = 1

    # PgBouncer ④: 사이드카(localhost:6432·pool_mode=transaction) 경유 여부(env DB_PGBOUNCER).
    # off(기본): 직접 Cloud SQL — 현 동작 100% 유지(사이드카 없어도 다운 X).
    # on: statement_cache 비활성(pooled conn 간 prepared statement reuse 깨짐 방지) +
    #     app-side pool 최소화(PgBouncer default_pool_size가 실 풀 역할).
    db_pgbouncer: bool = False
    db_pgbouncer_pool_size: int = 2  # flag on 時 app-side pool(PgBouncer가 실 풀)
    db_pgbouncer_max_overflow: int = 1

    # JWT
    jwt_secret: str = ""

    # CORS (쉼표 구분 origins, Cloud Run 환경변수 CORS_ORIGINS로 주입)
    cors_origins: str = "http://localhost:3000,http://localhost:3108,https://app.sprintable.ai"

    # App
    app_env: str = "development"
    debug: bool = False

    # OAuth — Google / GitHub
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""
    # Next.js 프론트엔드 URL (OAuth redirect_uri 조합용)
    app_url: str = "http://localhost:3000"

    # EE / SaaS gating
    license_consent: str = ""

    # E-EVENTBUS: dev=true, prod=false (기존 웹훅 병행 운영)
    eventbus_enabled: bool = False

    # E-ARCH S1(2026-07-21, 선생님 "가자" 승인 — 채팅 5초 지연/#2074 근본): REST(api)와
    # 실시간(SSE/LISTEN)이 같은 Cloud Run 서비스에 있어 인스턴스 기아(콜드스타트 경합)로
    # 서로를 굶기던 구조를 분리하는 1단계. 이 플래그를 끄면 이 인스턴스는 pg_pubsub LISTEN을
    # 전혀 시작 안 함(RAW_LISTEN 커넥션 소비 0) — api 서비스에 false, 신규
    # sprintable-realtime-{env} 서비스에 true로 배선한다(같은 이미지, env만 다름).
    # default=True(무회귀) — 명시적으로 끄지 않는 한 기존 단일서비스 배포와 동일 동작.
    pg_listen_enabled: bool = True

    # E-ARCH S2(story #2078·설계 오르테가군 판정 2026-07-21): PG NOTIFY 옆에 Redis(Memorystore)
    # dual-publish를 shadow로 추가하는 단계. default=False(무회귀) — Memorystore 인스턴스가 아직
    # 없어도(PO lane·1단계 abort-0 실측 확認 후 배선 예정) 이 PR 자체는 아무 동작도 안 바꾼다.
    # 켜져도 PG NOTIFY가 여전히 authoritative(dispatch는 PG 경로만 사용) — Redis는 realtime
    # gateway의 shadow-consume 비교용(지연·중복률 측정)이라 유실돼도 정합성 영향 0
    # (agent_gateway.py의 acked_seq DB 재조회 패턴과 동형 근거 — 오늘 세션 교차검증 완료).
    event_broker_redis_dual_publish_enabled: bool = False
    redis_url: str | None = None  # Memorystore 연결 문자열(공유 — event_broker + RedisRateLimiter). flag on인데 None이면 경고 로그만(fail-safe).

    # E-ARCH S2 근본 정정(2026-07-21, 착수 전 확認 — shadow-consume은 "도달" 관측이지 "전달"이
    # 아니었다): 원래 redis_consume_loop(구 redis_shadow_consume_loop)은 로그만 남기고
    # publish_event()/_push_to_agent()를 호출 안 했다 — 그 상태에서 PG_LISTEN_ENABLED=false로
    # LISTEN을 걷으면 Redis 발행은 되는데 아무도 안 받아 실시간이 전면 정지했을 것. 이 플래그가
    # 켜지면 그 loop이 실제로 SSE 큐까지 전달한다(self-skip 포함, pg_pubsub._dispatch_received
    # 와 동형). default=False — event_broker_redis_dual_publish_enabled만으로는 여전히 관측만
    # (무회귀). ⚠️event_broker_outbox_enabled와 동시에 켜지 말 것 — outbox 발행분은
    # instance_id가 없어 self-skip이 안 돼 중복 dispatch 위험(3b에서 해소 예정).
    event_broker_redis_dispatch_enabled: bool = False

    # E-ARCH S2 정리(2026-07-21, LISTEN 제거 완료 후 발견): redis_consume_loop task 생성이
    # event_broker_redis_dual_publish_enabled 하나로만 게이트돼 있었다 — dual_publish(발행,
    # 모든 인스턴스가 필요)와 consume(구독+dispatch, SSE를 실제로 서빙하는 서비스만 필요)
    # 역할이 뒤섞여, api(SSE 미서빙)도 불필요하게 Redis 구독을 유지했다(낭비 + shadow 비교
    # 로그 노이즈 — api는 LISTEN이 없어 PG 도착 기준점이 영원히 0이라 항상 "redis-only"로
    # 오독될 수 있는 상태였다). default=True(무회귀) — realtime이 이미 이 loop로 실 dispatch
    # 중이라 default를 False로 하면 재배포 시 실시간이 끊긴다. api 쪽만 GHA per-env override로
    # false 배선(story #2078 PG_LISTEN_ENABLED durable 분리·PR #2364와 동일 패턴).
    event_broker_redis_consume_enabled: bool = True

    # E-ARCH S3(story #2078) 3a단계: `event_outbox` row insert를 EventBroker.publish()에 추가로
    # 얹는다(호출 타이밍은 안 바뀜 — 여전히 caller commit 이후, 별도 짧은 트랜잭션이라 아직 진짜
    # atomic outbox는 아님). default=False(무회귀) — 켜지기 전엔 OutboxEventBroker가 inner
    # (DualPublishEventBroker) 동작만 그대로 위임한다. outbox_dispatcher_loop 도 이 플래그로
    # 게이트(꺼져 있으면 realtime gateway에서 폴링 task 자체를 안 만든다).
    event_broker_outbox_enabled: bool = False

    # E-L2 휴리스틱 트리거 워커. default-off — 명시 활성화 전엔 lifespan task 미생성(무동작).
    # advisory_lock=on이면 멀티인스턴스 중 pg_try_advisory_lock holder 1개만 poll/evaluate.
    l2_trigger_enabled: bool = False
    l2_trigger_advisory_lock: bool = False
    # S8 운영 config(안전 rollout). 모두 기본값=무제약/무필터.
    l2_trigger_disabled_types: str = ""  # CSV — 비활성화할 trigger_type(예 "velocity_spike,scope_creep")
    l2_trigger_org_allowlist: str = ""  # CSV org_id — 비면 전 org, 지정 시 해당 org만 발사
    l2_trigger_max_wakes_per_org_per_hour: int = 0  # >0이면 org 시간당 wake 상한(초과 skip), 0=무제한

    # E-H1 머지 verdict 게이트(report-done merge·board in-review→done 직접 PATCH). default-off —
    # 팀 워크플로 경로라 켜면 trust None일 때 done이 전부 보류돼 team stall. 실 enable은 S10 E2E+
    # 접는조건 後 의도적으로. allowlist 지정 시 해당 org만 게이트(점진 rollout).
    h1_merge_gate_enabled: bool = False
    h1_merge_gate_org_allowlist: str = ""  # CSV org_id — 비면 enabled 시 전 org, 지정 시 해당 org만
    # advisory(B): set 시 게이트 eval + decision/gate row/metrics는 기록하되 →done 차단(409/202)을
    # 면제(done 통과·관측만). cold-start 동안 coverage/우회율/seed 데이터 계속 쌓되 고마찰 차단은 면제.
    # 정책은 A(human-only enforcing)·advisory는 개발/관측용 임시 모드(미설정=enforcing 보존).
    h1_merge_gate_advisory: bool = False

    # E-HITL-GATING S-GATE-2: config 게이트 집행 활성(default-off·dev allowlist 점진 rollout·무회귀).
    # off면 enforce_gate 미동작(기존 done/merge 무변경). allowlist 비면 enabled 시 전 org, 지정 시 해당 org만.
    gate_config_enforce_enabled: bool = False
    gate_config_enforce_org_allowlist: str = ""  # CSV org_id

    # E-DG S18(P0-5): Decision Gate line engine 안전 롤아웃 control. default-off — 미설정 org 는
    # 라이브 100% 무영향(엔진 미진입). enabled+allowlist(비면 전 org) org 만 runtime mode 로 활성.
    # mode = off|shadow|advisory|enforcing(per-line config rollout_mode 와 min 으로 결합=보수적 ceiling).
    # circuit breaker(P0-1)가 engine failure 다발 시 org 를 advisory 로 자동 강등(보드 freeze 방지).
    decision_gate_line_enabled: bool = False
    decision_gate_line_org_allowlist: str = ""  # CSV org_id — 비면 enabled 시 전 org, 지정 시 해당 org만
    decision_gate_line_mode: str = "off"  # off|shadow|advisory|enforcing(기본 off)

    # E-MEMBER-SSOT AC2-3: 신원 해소를 anchor(members+member_identity_aliases) 기반으로 전환하는
    # shadow 플래그. off(기본)=레거시 resolver(org_members/team_members). on=anchor resolver.
    # 라이브 cutover는 AC3-1 — 여기선 shadow(parity 검증용), 기본 off라 실 read 경로 무변경.
    member_ssot_resolver_shadow: bool = False

    # E-MEMBER-SSOT AC3-1: API key 인증을 canonical members.id로 cut하는 플래그.
    # off(기본)=team_members 경로(레거시), on=members 경로. ⚠️ 전 에이전트 통신 생명선이라
    # 머지 후에도 off 기본 — 실 에이전트 무중단 실증 후 단계적 on.
    member_ssot_apikey_cut: bool = False

    # 908075db 단계1: _build_app_metadata de-fallback. off(기본)=기존 추측 fallback 거동 100% 유지.
    # on=명시 의도(switch target / 저장된 last_project_id)에 has_project_access(35a0691e grant-aware) 있으면
    # 그 project를 존중(가장-오래된-team_member 추측 skip). 단계1은 명시존중 분기만 추가 — 추측 fallback과
    # side-effect(last_project_id 덮어쓰기)는 단계2서 제거. flag off=거동 무변경(회귀 0), gcloud 무관.
    build_app_metadata_defallback: bool = False

    # Polar Billing SDK
    polar_access_token: str = ""
    polar_sandbox: bool = True  # dev=True(sandbox), prod=False
    polar_webhook_secret: str = ""  # HMAC signature 검증용

    # E-H1-S6: GitHub webhook(PR/CI verdict 캡처) HMAC 검증 시크릿. 미설정이면 webhook 거부(inert).
    github_webhook_secret: str = ""

    # E-GHAPP Bot-S: GitHub App(봇) — per-org 설치/링킹. user-login OAuth(github_client_id/secret)와
    # 별개 credential. private key 는 Secret Manager only(env 는 dev/local fallback·로그 노출 0).
    github_app_id: str = ""                  # GitHub App numeric id (installation 토큰 API 경로용)
    github_app_client_id: str = ""           # App client ID — JWT `iss`(현 권장)
    github_app_client_secret: str = ""        # App OAuth client secret — install callback user-token 교환(소속 검증)
    github_app_slug: str = ""                # 설치 URL: github.com/apps/<slug>/installations/new
    github_app_private_key: str = ""         # PEM. dev/local fallback only — prod 는 Secret Manager
    github_app_private_key_secret: str = ""  # Secret Manager resource name (prod 우선 소스)
    github_app_state_secret: str = ""        # 설치 callback state(CSRF+org+nonce+TTL) 서명 키
    # Bot-M.2: App 웹훅 HMAC 시크릿(legacy github_webhook_secret 과 분리). 미설정=app-source inert.
    # github_webhook_secret 과 동일값(misconfig)이면 app inert + startup warning(legacy 무회귀 보존).
    github_app_webhook_secret: str = ""

    # S-COMM-07: 에이전트 inbox webhook HMAC 검증 시크릿
    agent_inbox_webhook_secret: str = ""

    # Rate limiting (E-OA1:S5)
    rate_limit_backend: str = "memory"  # "memory" | "redis"
    # ⚠️ story #2078 핫픽스(2026-07-21, Memorystore 배선 직전 PO가 발견): 이 필드가 원래 여기
    # `str = "redis://localhost:6379/0"`로 별도 선언돼 있었다 — event_broker용 `redis_url`
    # (위 line 98, `str | None = None`)과 이름이 같아 파이썬 클래스 바디에서 나중 선언이 이겼다
    # (Pydantic 필드 shadowing). 실제 `settings.redis_url` 기본값은 이 truthy localhost
    # 문자열이었고, event_broker.py의 "None이면 fail-safe skip" 체크가 여기 가려져 한 번도
    # 안 걸렸다(PR #2363에서 신설한 필드가 죽어있던 상태). 단일 필드로 통합 — event_broker와
    # RedisRateLimiter가 같은 Memorystore 인스턴스 하나를 봐야 맞고, rate_limit_backend="redis"
    # 인데 redis_url이 None이면 aioredis.from_url(None)이 명시적으로 실패하는 게 조용한
    # localhost 오접속보다 낫다.

    # E-AUTH-REBUILD M2 Phase 1(story b07ad526·doc firebase-auth-identity-platform-migration-poc
    # §10.1): Firebase Auth/Identity Platform 이행 플래그. 전부 default off — Phase 1 스키마+검증기
    # 구현은 이 플래그들 뒤에서 dead code로 존재(prod 무영향). LEGACY_AUTH_ISSUE/VERIFY만 on이
    # 기본이라 기존 self-issued JWT 로그인/세션이 그대로 SSOT.
    firebase_auth_accept_id: bool = False        # native/direct 경로에서 Firebase ID token 수락
    firebase_auth_accept_session: bool = False   # Firebase 세션쿠키(__Host-sp_fs) 수락
    firebase_auth_issue_session: bool = False    # 신규 Firebase 세션쿠키 발급
    firebase_auth_reset_cutover: bool = False    # Phase 4 coordinated forced-reset 전이 허용
    firebase_auth_cohort_percent: int = 0        # Phase 5 점진 롤아웃 비율(0~100)
    firebase_auth_mobile_issue: bool = False     # M2 모바일 native bootstrap 발급
    # story 1931(OAuth 핸드오프·doc e-mobile-oauth-native-handoff-contract §4/§7.5(b)):
    # attested native bootstrap(§7.5)과 별개인 경량 OAuth-handoff issue/consume(PKCE) 발급.
    firebase_oauth_handoff_enabled: bool = False
    legacy_auth_issue: bool = True               # 기존 self-issued JWT 로그인/refresh 발급
    legacy_auth_verify: bool = True              # 기존 self-issued JWT 검증(proxy.ts·FastAPI)

    # ⛔P0(신 클래스, #1887과 별개) — proxy.ts singleFlightRefresh는 Cloud Run 인스턴스-로컬
    # in-memory Map이라 멀티인스턴스(session affinity 꺼짐, gcloud 실측 dev max=3) 간 dedupe가
    # 안 된다. 하드리프레시의 병렬 인증요청이 인스턴스 분산되면 같은 refresh_token으로 동시
    # rotate 경합 → 진 쪽은 원자 single-use rotation에 의해 TOKEN_REVOKED 401 → FE가
    # clearAuthCookies() 실행 → 세션은 살아있는데 강제 로그아웃. FE 그레이스 재사용 패턴
    # (REFRESH_GRACE_MS=5000, proxy.ts)을 BE로 옮겨 인스턴스 개수/라우팅과 무관하게 만든다
    # (오르테가·미르코 판단: Redis로 FE 상태공유는 proxy.ts가 edge 런타임이라 과한 인프라 —
    # 배제. DB-only fork-rotation이 근본이면서 인프라 안 키우는 정공법).
    auth_refresh_grace_seconds: int = 5

    firebase_project_id: str = ""  # Firebase/Identity Platform GCP 프로젝트 ID(dev/prod 분리)

    # story 132e7204(Phase1-S4): Next.js BFF↔FastAPI 세션쿠키 발급 내부 호출 공유시크릿.
    # cron.py CRON_SECRET과 동일 패턴 — 미설정(로컬 개발) 시 인증 생략.
    firebase_bff_internal_secret: str = ""

    # story 4dee942b(Phase1-S5): 네이티브 부트스트랩 — custom token→ID token 교환용 Firebase
    # Web API key(공개 클라이언트 키, ADC와 별개). App Check 검증용 project number(project_id와
    # 다른 값 — doc §9.3/산티아고 §9). App Check 필수 여부 게이트(기본 off — 모바일 클라이언트
    # per-install challenge 메커니즘이 아직 없어 강제 시 발급 자체가 막힘, 별도 모바일 스토리 필요).
    firebase_web_api_key: str = ""
    firebase_project_number: str = ""
    firebase_auth_mobile_app_check_required: bool = False
    # 산티아고 §9 finding 1(2026-07-15): App Check sub(App ID) allowlist — 콤마 구분 문자열.
    # 미승인 앱이 App Check 토큰을 정확 서명해와도 이 목록에 없으면 거부.
    firebase_app_check_allowed_app_ids: str = ""

    # story cbd578d4(C4·산티아고 §7.3): per-install register 엔드포인트가 attestation
    # rpIdHash/AttestationApplicationId 검증에 강제하는 exact 값들. 미설정 시 register는
    # 항상 거부(fail-closed) — dev/prod 실 앱 식별자 프로비저닝 후 채워진다.
    ios_team_id: str = ""
    android_signing_cert_digest_sha256_hex: str = ""
    android_min_version_code: int = 0
    play_integrity_project_number: str = ""
    # §7.3: 사용자당 bounded N개 active installation — 초과 등록은 fresh re-auth(이미 강제,
    # 5분 auth_time freshness)+MFA(user.totp_enabled 전제) 요구.
    device_installation_max_active_per_user: int = 5

    @property
    def is_ee_enabled(self) -> bool:
        return self.license_consent.lower() == "agreed"

    @property
    def is_really_local(self) -> bool:
        """story #2071(critical, 2026-07-21) 근본수정 — `app_env=="development"`만으로는
        "개발자 랩탑"과 "인터넷에 노출된 dev Cloud Run 배포"를 구분 못 한다(둘 다 동일
        APP_ENV=development). Cloud Run은 `K_SERVICE`를 항상 자동 주입한다(설정 불필요 —
        `app/core/database.py`의 커넥션 태깅과 동일 SSOT, 신규 발명 아님). 이게 없으면(로컬
        uvicorn/pytest) 진짜 로컬, 있으면(dev든 prod든) Cloud Run 위라 fail-open 대상이 아니다.
        내부 secret 게이트(auth_firebase_internal.py·cron.py 등)가 "시크릿 미설정=로컬이니
        허용" 판정을 내릴 때 이 프로퍼티로 좁혀야 한다 — `app_env` 문자열만 보면 노출된 dev가
        그대로 열린다(#2071이 이 클래스의 첫 사례)."""
        import os
        return not os.environ.get("K_SERVICE")


settings = Settings()
