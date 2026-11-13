"""CI 서비스 Postgres 이미지는 digest로 못 박혀 있다 (페드루 PO 결정 2026-11-13).

결함: `.github/workflows/ci.yml`의 서비스 컨테이너가 떠다니는 태그 `pgvector/pgvector:pg16`을 썼다. 그 태그가 2026-11-12 23:08Z에 PG 16.15 → 16.16 이미지로 새로 올라오자(마지막 초록 5687은 15:11Z
digest 0dd3149a… = 16.15, 그 뒤 빨강 런은 digest 484e8380… = 16.16) 스키마 덤프를 비교하는 시험(test_3804 · test_4010)이 컬럼마다 `SET (pg_attver=N)` 숫자만 달라 빨개졌다.
태그가 우리 모르게 시험 판을 바꾼 것 — 덮는 게 아니라 판을 고정하는 것이 고침이다. 이 시험은 그 고정이 «모든 워크플로 파일의 모든 Postgres 서비스 이미지에 같은 digest로» 남아 있는지 지킨다
(누가 `pg16` 태그로 되돌리거나 한 잡만 다른 digest를 쓰면 RED). YAML을 파싱해 읽으므로 따옴표 · 줄 끝 주석이 붙어도 놓치지 않는다.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
_PINNED = re.compile(r"^pgvector/pgvector:pg16@sha256:[0-9a-f]{64}$")


def _service_images() -> list[tuple[str, str, str]]:
    """(파일, 잡, 이미지) — 서비스 컨테이너 이미지 중 postgres/pgvector 계열 전부."""
    found: list[tuple[str, str, str]] = []
    for path in sorted(_WORKFLOWS.glob("*.y*ml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for job_name, job in (doc.get("jobs") or {}).items():
            for svc in ((job or {}).get("services") or {}).values():
                image = str((svc or {}).get("image", ""))
                if "postgres" in image or "pgvector" in image:
                    found.append((path.name, job_name, image))
    return found


def test_ci_has_pgvector_service_images():
    # 헛돌지 않게: 서비스 이미지가 실제로 읽힌다(8곳 이상 — 줄어들면 다른 방식으로 바뀐 것이니 이 시험을 같이 고쳐야 한다)
    assert len(_service_images()) >= 8


def test_every_postgres_service_image_is_pinned_by_digest():
    unpinned = [x for x in _service_images() if not _PINNED.match(x[2])]
    assert unpinned == [], f"digest로 안 박힌 Postgres 서비스 이미지(파일 · 잡 · 이미지): {unpinned}"


def test_every_postgres_service_image_uses_the_same_digest():
    digests = {image.split("@", 1)[1] for _, _, image in _service_images() if "@" in image}
    assert len(digests) == 1, f"서비스 이미지 digest가 잡마다 다르다: {sorted(digests)}"
