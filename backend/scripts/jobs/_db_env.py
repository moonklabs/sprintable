"""공용 헬퍼 — scripts/jobs/ 스크립트가 DATABASE_URL 없이 ALEMBIC_URL만 있는 환경(Cloud Run
Job `sprintable-verify-oneoff` 등)에서도 돌 수 있게 하는 폴백.

story #2223 후속(오르테가 판정, 2026-07-31)에서 `backfill_reference_semantic_candidates.py`에
처음 인라인으로 생겼다가, story #2384에서 같은 잡으로 옮겨진 두 스크립트(`backfill_activity_events.py`,
`expire_undeliverable_pending_dispatched_events.py`)가 이 폴백 없이 옮겨져 카디르군 REQUEST_CHANGES로
드러났다 — 문서(README AC4)는 패턴을 알았는데 옮겨진 코드가 그걸 안 따랐다. 세 번째 사본을 또
안 만들려고 여기로 뺐다.

⛔ 호출 시점 주의: `app.core.database`의 `engine`은 그 모듈 **import 시점**에
`settings.database_url`(pydantic, DATABASE_URL env 자동매핑)로 한 번만 만들어진다. 이 함수는
반드시 그 import **前**에 호출돼 os.environ["DATABASE_URL"]을 채워야 한다 — main() 안에서
늦게 부르면 이미 만들어진 engine엔 반영되지 않는다("main() 안 폴백은 이미 늦다").
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit


def resolve_database_url() -> str | None:
    """DATABASE_URL이 있으면 그것을 그대로 쓴다. 없고 ALEMBIC_URL이 있으면 psycopg2→asyncpg
    스킴 변환 후 os.environ["DATABASE_URL"]에 심는다. 반환값은 로그용 요약(스킴+호스트만) —
    자격증명은 절대 담지 않는다. 둘 다 없으면 None."""
    if os.environ.get("DATABASE_URL"):
        source = "DATABASE_URL"
    elif os.environ.get("ALEMBIC_URL"):
        raw = os.environ["ALEMBIC_URL"]
        converted = raw
        for prefix in ("postgresql+psycopg2://", "postgresql://"):
            if raw.startswith(prefix):
                converted = "postgresql+asyncpg://" + raw[len(prefix):]
                break
        os.environ["DATABASE_URL"] = converted
        source = "ALEMBIC_URL(스킴 변환)"
    else:
        return None

    parts = urlsplit(os.environ["DATABASE_URL"])
    return f"{source} → scheme={parts.scheme} host={parts.hostname}"
