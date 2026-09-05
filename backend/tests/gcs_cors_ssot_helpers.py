"""story #3545 — GCS CORS json 파일이 서명 create-only PUT에 필요한 요청 헤더를
전부 허용하는지 재는 공용 헬퍼. `infra/gcs-attachments-cors.json`과
`infra/gcs-channel-media-cors.json` 둘 다 같은 실패 클래스(#3242 → #3545 재발)를
겪었다 — 필요 헤더 값을 각 테스트 파일에 따로 하드코딩하면 세 번째 버킷이 또
같은 구멍을 낸다. `GcsStorageProvider.required_write_headers()`가 유일한 정본이라
여기서 한 번만 읽어 두 파일 모두에 강제한다.
"""
from __future__ import annotations

import json
from pathlib import Path

from app.services.storage.gcs import GcsStorageProvider


def assert_cors_file_allows_required_write_headers(cors_file: Path) -> None:
    """create-only PUT(서명 업로드)에 GCS가 실제로 요구하는 헤더 전부가 이 CORS
    json의 responseHeader 목록에 있는지 pin한다. GCS의 responseHeader는 preflight
    Access-Control-Allow-Headers에 대응한다(Expose-Headers가 아니다) — 여기 없으면
    프리플라이트 자체가 막힌다(#3242·#3545 실사고)."""
    rules = json.loads(cors_file.read_text())
    all_headers = {h for rule in rules for h in rule.get("responseHeader", [])}
    required = GcsStorageProvider().required_write_headers(create_only=True)
    missing = set(required.keys()) - all_headers
    assert not missing, f"{cors_file.name}: 서명 create-only PUT 필수 헤더 누락(프리플라이트 차단): {missing}"
