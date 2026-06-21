from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")

    # Database
    # Cloud SQL Auth Proxy 연결 예시:
    #   postgresql+asyncpg://sprintable:PASSWORD@127.0.0.1:5433/sprintable
    # Cloud SQL Unix socket 연결 예시 (Cloud Run 등):
    #   postgresql+asyncpg://sprintable:PASSWORD@/sprintable?host=/cloudsql/sprintable:asia-northeast3:sprintable-dev
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"

    # Cloud SQL (D-S1: Phase D GCP 인프라)
    cloud_sql_instance_dev: str = "sprintable-494803:asia-northeast3:sprintable-dev"
    cloud_sql_instance_prod: str = "sprintable-494803:asia-northeast3:sprintable-prod"

    # E-INFRA S2: DB 커넥션 풀 right-size (env DB_POOL_SIZE / DB_MAX_OVERFLOW로 override).
    # 산식: (maxScale × (pool_size + max_overflow)) + admin/migration headroom ≤ max_connections.
    #   prod(sprintable-prod db-g1-small, max_connections=100, maxScale=10):
    #     10 × (5 + 3) = 80  + ~20 headroom(superuser_reserved 3 + migrate-prod 잡 + 수동 admin) = 100 ✓
    #   dev(maxScale=3): 3 × (5+3)=24 로 여유 큼 — 필요 시 env로 상향(예 10/20) 독립 right-size.
    # ⚠️ --concurrency=80(인스턴스당 동시 HTTP 요청)과 별개: 풀은 **DB op 점유 구간만** 커넥션을 잡고
    #    즉시 반납하므로 80 동시요청 ≠ 80 커넥션. pool+overflow 초과분은 pool_timeout 대기(실패 아님).
    db_pool_size: int = 5
    db_max_overflow: int = 3

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

    # S-COMM-07: 에이전트 inbox webhook HMAC 검증 시크릿
    agent_inbox_webhook_secret: str = ""

    # Rate limiting (E-OA1:S5)
    rate_limit_backend: str = "memory"  # "memory" | "redis"
    redis_url: str = "redis://localhost:6379/0"

    @property
    def is_ee_enabled(self) -> bool:
        return self.license_consent.lower() == "agreed"


settings = Settings()
