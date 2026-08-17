"""story #2720(2026-08-17, AC3) — BE↔FE canonicalization 규칙 정합 pin.

BE `asset_registry.canonical_object_path`와 FE `lib/storage/canonical.ts`의
`canonicalObjectPath`는 서로 다른 언어(Python/TypeScript)라 코드 자체를 공유할 수 없다 —
"같은 규칙, 각자 언어로 재현"만 가능(story #2720 그라운딩 결론 ⓒ). 이 파일은 그 정합을
**같은 입력 벡터 테이블**을 두 언어 테스트가 각자 돌려 확인하는 방식으로 pin한다.

⚠️짝 파일: apps/web/src/lib/storage/canonical.test.ts의 `PARITY_VECTORS`(아래와 동일
input/expected 쌍) — 한쪽만 고치고 다른 쪽을 안 고치면 이 주석이 거짓말이 되니, 벡터를
바꿀 땐 반드시 두 파일을 함께 갱신한다.
"""
from __future__ import annotations

import pytest

from app.services.asset_registry import canonical_object_path

_BUCKET = "sprintable-memo-attachments"
_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"

# (input, expected) — apps/web/src/lib/storage/canonical.test.ts의 PARITY_VECTORS와 정확히
# 동일해야 한다(순서 무관, 쌍만 일치).
PARITY_VECTORS: list[tuple[str, str | None]] = [
    (_PREFIX + "chat/p/c/u-a.png", "chat/p/c/u-a.png"),
    ("story/p/s/u-a.png", "story/p/s/u-a.png"),
    (
        _PREFIX + "org/o1/project/p1/canvas-import/abc-shot.png"
        "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef",
        "org/o1/project/p1/canvas-import/abc-shot.png",
    ),
    ("http://evil/a.png", None),
    ("https://storage.googleapis.com/other-bucket/a.png", None),
    ("gs://other-bucket/a.png", None),
    ("file:///etc/passwd", None),
    ("http://evil.com/" + _BUCKET + "/a.png", None),
    ("", None),
    (_PREFIX, None),
]


@pytest.mark.parametrize("stored_url,expected", PARITY_VECTORS)
def test_be_canonicalization_matches_parity_vectors(stored_url, expected):
    assert canonical_object_path(stored_url, _BUCKET) == expected
