"""story #3261 AC1 — 역할별 모델 계층이 설정값(어드민 가변)으로 라우팅되는 지점. Blueprint
v0.4 §4.3 실측 확定 단가표를 코드 상수로도 고정해 cost_cap.py가 usage_metadata의 토큰수만으로
$ 환산할 수 있게 한다(role 문자열이 아니라 실 model id 기준 — 어드민이 role의 model을 바꿔도
가격표 조회는 그 model id를 그대로 찾는다).

⛔가격은 여기 하드코딩 상수가 유일한 SSOT다 — Vertex 응답에 가격이 안 실려서(usage_metadata는
토큰수만 준다) 어디선가는 고정해야 하고, 프로젝트 관례(no-sloppy-products 원칙)상 "일단
대충"이 아니라 실측 SKU 값 그대로 박아둔다(Blueprint v0.4 §4.3, 2026-08-31 gcloud 실측)."""
from __future__ import annotations

from dataclasses import dataclass

from app.config import settings


class Role:
    INTERACTION = "interaction"
    KNOWLEDGE = "knowledge"
    ORG_STATUS = "org_status"
    ESCALATION = "escalation"
    CLASSIFIER = "classifier"
    EMBEDDING = "embedding"


@dataclass(frozen=True)
class ModelPrice:
    input_per_million: float
    output_per_million: float


# Blueprint v0.4 §4.3 실측(2026-08-31, sprintable-494803 Cloud Billing Catalog 조회) — $/1M 토큰.
PRICE_TABLE: dict[str, ModelPrice] = {
    "gemini-3.1-pro": ModelPrice(2.00, 12.00),
    "gemini-2.5-pro": ModelPrice(1.25, 10.00),
    "gemini-3.7-flash": ModelPrice(1.50, 7.50),
    "gemini-2.5-flash": ModelPrice(0.15, 0.60),
    "gemini-3.1-flash-lite": ModelPrice(0.25, 1.50),
    "gemini-2.5-flash-lite": ModelPrice(0.10, 0.40),
}


def model_for(role: str) -> str:
    return {
        Role.INTERACTION: settings.model_interaction,
        Role.KNOWLEDGE: settings.model_knowledge,
        Role.ORG_STATUS: settings.model_org_status,
        Role.ESCALATION: settings.model_escalation,
        Role.CLASSIFIER: settings.model_classifier,
        Role.EMBEDDING: settings.model_embedding,
    }[role]


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """PRICE_TABLE에 없는 model(예: 지식원 미도입 임베딩 등)은 None — cost_cap이 "모른다"를
    "0원"으로 오판하지 않도록 호출부가 None을 별도 처리한다."""
    price = PRICE_TABLE.get(model)
    if price is None:
        return None
    return (input_tokens / 1_000_000) * price.input_per_million + (output_tokens / 1_000_000) * price.output_per_million


# story #3262(지원v1·4지식원) — 임베딩은 $/1M **문자**(토큰 아님, google-genai
# EmbedContentResponse.metadata.billable_character_count 실측 확認). PRICE_TABLE(토큰 단가)에
# 섞으면 단위가 달라 estimate_cost_usd가 조용히 틀린 값을 낸다 — 그래서 별도 상수+함수.
# gemini-embedding-001 = "Large Text Embedding Model - Predictions" SKU(Cloud Billing Catalog
# 실조회, skuId=E4FB-7AE2-9CAE) — Blueprint §4.3 임베딩 행 1후보와 일치.
EMBEDDING_PRICE_PER_MILLION_CHARS: dict[str, float] = {
    "gemini-embedding-001": 0.15,
}


def estimate_embedding_cost_usd(model: str, billable_character_count: int) -> float | None:
    price = EMBEDDING_PRICE_PER_MILLION_CHARS.get(model)
    if price is None:
        return None
    return (billable_character_count / 1_000_000) * price
