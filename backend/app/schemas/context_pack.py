import uuid

from pydantic import BaseModel


class ContextPackSearchResult(BaseModel):
    """P1-S6: 유사도 검색 결과 1건. entity_type/entity_id는 embeddings의 폴리모픽 참조를 그대로 노출
    (호출자가 S7 Context Pack 조립 시 해당 엔티티를 직접 로드)."""
    entity_type: str
    entity_id: uuid.UUID
    embedding_text: str
    similarity: float
