"""story #3259(지원v1·1경계) — 이 서비스의 설정은 backend/app/core/config.py와 **의도적으로
분리**돼 있다. 공유 Settings 클래스를 상속하거나 import하면 fleet 전용 값(JWT_SECRET·MCP
시크릿·billing 키 등)이 이 프로세스의 환경/타입 시그니처에 실려 "0 fleet 자격" 불변식이
코드 레벨에서 깨진다 — 이 파일이 아는 값은 정확히 이 서비스가 필요로 하는 것뿐이어야 한다.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SUPPORT_GATEWAY_", extra="ignore")

    # 전용 DB — story #3259 AC2(물리 분리). 절대 backend의 DATABASE_URL과 같은 인스턴스를
    # 가리키지 않는다(Blueprint v0.3 §0 "우리 org 데이터와 완전 분리된 별도 에이전트").
    database_url: str = ""

    # backend가 발급하는 org-스코프 위임 토큰을 검증할 전용 시크릿. backend의 JWT_SECRET과
    # 별개 값 — 이 서비스가 아는 유일한 "신뢰 재료"이며, 이걸로 fleet 인증 토큰을 위조하거나
    # 검증할 수 없다(별도 서명 키 도메인, backend/app/routers/support_gateway_token.py 참고).
    token_secret: str = ""

    # rate limit 저장소 — 미설정 시 memory://(단일 인스턴스 전제, dev 기본). prod는 별도
    # Redis(Memorystore) 인스턴스 권장 — backend가 쓰는 redis_url과 공유하지 않는다(경계
    # 유지: rate limit 상태 유출도 결국 org 활동 패턴 유출).
    redis_url: str | None = None

    # 세션 API rate limit 기본값(org당). 어드민 가변값 축은 story #6(방어·계측) 스코프.
    session_rate_limit: str = "30/minute"

    # 위임 토큰 만료(초) — 짧게: 유출돼도 피해 창을 최소화.
    token_ttl_seconds: int = 300

    # story #3260(위젯 셸) — 브라우저가 이 서비스를 **직접** 호출한다(Next.js BFF 프록시
    # 경유 아님, 별도 Cloud Run 오리진이라 실제 CORS preflight가 돈다 — backend/app/core/
    # config.py의 cors_origins는 대부분 서버사이드 프록시 경유라 사실상 미사용인 것과 다름).
    # list[str] 대신 backend와 동일하게 comma-구분 문자열로 받는다 — pydantic-settings의
    # list[str] env 파싱은 JSON을 기대해, 값 안의 콤마가 gcloud --update-env-vars의 comma-
    # 구분 ArgDict 파싱과 이중으로 충돌한다(cloudbuild.yaml MCP_ALLOWED_HOSTS 선례와 동일
    # 함정 — 이 필드 자체를 그 함정 밖으로 뺀다).
    cors_origins: str = ""

    # story #3261(지원v1·3오케스트레이션) — Vertex AI SDK 접속 좌표. GCP credit 경계
    # 안(Blueprint §4.1) — Claude 등 파트너 모델은 이 서비스가 아예 모른다(SDK가 vertexai=True
    # 백엔드만 두드림). location="global" — AC④ 실측 확定(Pro·Flash-Lite가 asia-northeast3
    # 리전 엔드포인트에서 404, global에서만 200 — Blueprint v0.4 §4.3 참고). Cloud Run 배포
    # 시엔 이 값들 위에 전용 서비스계정의 ADC(메타데이터 서버)가 자동 인증 — 별도 시크릿 불요.
    vertex_project: str = ""
    vertex_location: str = "global"

    # story #3261 §4.3(v0.4 실측) 역할별 모델 계층 — 어드민 가변값 축(AC1). 절약후보로
    # 기본값을 잡는다(비용 우선 — PO가 품질 필요시 1후보로 승격 설정).
    model_interaction: str = "gemini-2.5-pro"
    model_knowledge: str = "gemini-2.5-flash"
    model_org_status: str = "gemini-2.5-flash-lite"
    model_escalation: str = "gemini-2.5-flash-lite"
    model_classifier: str = "gemini-2.5-flash-lite"

    # story #3262(지원v1·4지식원) — 지식 검색층 임베딩 모델. Blueprint §4.3 임베딩 행 2후보
    # ("Large Text Embedding Model" $0.15/1M · "Gemini MM Embedding – Text" $0.20/1M) 중
    # gemini-embedding-001로 확定(SDK 실호출 확認 — dim=3072, "Large Text Embedding Model"
    # SKU에 대응. Gemini MM Embedding 계열은 텍스트만 다루는 이 유스케이스엔 모달리티가
    # 안 맞아 제외 — app/knowledge_search.py 상단 주석 참고).
    model_embedding: str = "gemini-embedding-001"

    # story #3261 AC5 — 비용 상한(어드민 가변값). 초과 시 "정직한 지연 안내+사람 에스컬레이션"
    # (app/cost_cap.py) — 조용한 모델 강등 금지(Blueprint §4.3 원칙 그대로).
    cost_cap_org_daily_usd: float = 5.0
    cost_cap_org_session_usd: float = 1.0

    # story #3261 AC3 — org별 대화 메모리 요약 압축 트리거(메시지 개수 기준, v1 단순 휴리스틱).
    memory_summarize_after_messages: int = 20

    # story #3263(지원v1·5에스컬레이션) — escalation_task가 사람 전달 이벤트를 던지는 backend
    # 엔드포인트 절대 URL(예: https://sprintable-backend-dev-xxx.run.app/api/v2/support/
    # escalation-events). 미설정이면 배달을 정직하게 skip한다(SupportEscalation 행 생성 자체는
    # 막지 않음 — escalation_delivery.py 참고). token_secret과 짝(같은 대칭키를 역방향으로
    # 재사용, backend 자격을 새로 받지 않는다 — Blueprint §2 경계).
    backend_escalation_events_url: str = ""

    # story #3264(지원v1·6방어·계측) AC3/AC4 — 어드민 계측 조회(GET /api/v1/admin/metrics)
    # 인증. backend의 어떤 admin/fleet 자격도 이 서비스가 몰라야 하므로(zero fleet 자격
    # 불변식) 완전히 별도의 정적 시크릿 — 고객 위임 토큰(token_secret)과도 다른 신뢰 재료다.
    # 미설정(빈 문자열) 시 fail-closed — "누구나 조회 가능"이 아니라 "전부 거부"
    # (feedback_actor_type_failclosed와 동형). prod는 PO가 실 시크릿 프로비저닝.
    admin_token: str = ""


settings = Settings()
