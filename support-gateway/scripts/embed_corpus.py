"""story #3262(지원v1·4지식원) — 릴리즈 연동 갱신 규칙의 실행부(Blueprint §5-4 AC3).

`app/knowledge/corpus.py`의 정본 문서 내용이 바뀔 때마다 이 스크립트를 재실행해
`app/knowledge/embeddings.json`을 재생성한다. 문서 임베딩을 요청마다 실시간 계산하지 않고
배포 시점에 1회 고정하는 설계(app/knowledge_search.py 상단 주석)라, 이 스크립트가 그
"고정" 지점 자체다 — 안 돌리면 embeddings.json이 낡은 채로 배포되고, 검색이 옛 내용
기준으로 동작한다(`tests/test_knowledge_corpus_embeddings_sync.py`가 이 드리프트를 해시
불일치로 CI에서 잡는다).

사용:
    uv run python scripts/embed_corpus.py

인증: 기본은 ADC(Cloud Build/CI 러너·Cloud Run 등에서 정상 동작). 로컬 개발 중 ADC가
reauth 상태라 막히면(known issue — memory dev_db_read_via_cloudrun_job과 동형) 환경변수
GOOGLE_OAUTH_ACCESS_TOKEN에 `gcloud auth print-access-token` 값을 넣어 우회할 수 있다
(개발 편의용 — 이 분기는 production VertexLLMClient에는 없다, app/vertex_client.py 참고)."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path

from app.config import settings
from app.knowledge.corpus import KNOWLEDGE_CHUNKS
from app.model_config import Role, model_for

_OUTPUT_PATH = Path(__file__).parent.parent / "app" / "knowledge" / "embeddings.json"


def content_hash() -> str:
    """corpus.py 내용이 바뀌면 이 해시도 바뀐다 — sync 테스트가 이걸로 드리프트를 잡는다."""
    joined = "\x1f".join(f"{c.id}\x1e{c.content}" for c in KNOWLEDGE_CHUNKS)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


async def main() -> None:
    from google import genai
    from google.genai import types

    token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN")
    credentials = None
    if token:
        from google.oauth2.credentials import Credentials

        credentials = Credentials(token=token)

    client = genai.Client(
        vertexai=True, project=settings.vertex_project, location=settings.vertex_location, credentials=credentials
    )
    model = model_for(Role.EMBEDDING)

    vectors: dict[str, list[float]] = {}
    for chunk in KNOWLEDGE_CHUNKS:
        resp = await client.aio.models.embed_content(
            model=model,
            contents=[chunk.content],
            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", title=chunk.title),
        )
        vectors[chunk.id] = list(resp.embeddings[0].values)
        print(f"embedded {chunk.id!r} — dim={len(vectors[chunk.id])}")

    _OUTPUT_PATH.write_text(
        json.dumps(
            {
                "model": model,
                "content_hash": content_hash(),
                "chunk_count": len(KNOWLEDGE_CHUNKS),
                "vectors": vectors,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"wrote {_OUTPUT_PATH} ({len(vectors)} vectors, model={model})")


if __name__ == "__main__":
    asyncio.run(main())
