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

    cors_allow_origins: list[str] = []


settings = Settings()
