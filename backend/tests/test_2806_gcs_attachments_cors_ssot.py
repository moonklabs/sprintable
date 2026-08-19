"""story #2806 — GCS 첨부 버킷 CORS SSOT(infra/gcs-attachments-cors.json + cloudbuild.yaml
apply-gcs-attachments-cors 스텝) 선언 정합성. 순수 정적 검증(실 gcloud 호출 없음) —
"동작은 한 곳에서만 선언" 원칙의 pin(feedback_pin_declarations_as_tests류)."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CORS_FILE = _REPO_ROOT / "infra" / "gcs-attachments-cors.json"
_CLOUDBUILD = _REPO_ROOT / "cloudbuild.yaml"

_DEV_ORIGIN = "https://sprintable-frontend-dev-57iommnikq-du.a.run.app"
_PROD_ORIGIN = "https://app.sprintable.ai"


def _load_cors_rules() -> list[dict]:
    return json.loads(_CORS_FILE.read_text())


def test_cors_file_is_valid_json_with_required_origins():
    rules = _load_cors_rules()
    assert len(rules) >= 1
    all_origins = {o for rule in rules for o in rule.get("origin", [])}
    assert _DEV_ORIGIN in all_origins, "dev FE canonical origin 누락(gcloud run services describe로 실측한 값)"
    assert _PROD_ORIGIN in all_origins, "prod origin 누락(cloudbuild.yaml _NEXT_PUBLIC_APP_URL과 동일 값이어야 함)"


def test_cors_file_allows_get_for_signed_url_fetch():
    """docx-preview의 client fetch()는 GET — 이게 없으면 CORS를 채워도 여전히 차단된다."""
    rules = _load_cors_rules()
    all_methods = {m for rule in rules for m in rule.get("method", [])}
    assert "GET" in all_methods


def test_cloudbuild_apply_step_references_the_cors_file_exactly():
    """⭐선언 정합성 — cloudbuild.yaml의 apply-gcs-attachments-cors 스텝이 참조하는
    --cors-file 경로가 실제 이 파일과 정확히 일치하는지(파일명 드리프트 방지)."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next((s for s in doc["steps"] if s["id"] == "apply-gcs-attachments-cors"), None)
    assert step is not None, "cloudbuild.yaml에 apply-gcs-attachments-cors 스텝이 없음"
    assert step["entrypoint"] == "bash"
    script = step["args"][1]
    assert "infra/gcs-attachments-cors.json" in script
    assert "gcloud storage buckets update" in script
    assert "sprintable-memo-attachments" in script


def test_cloudbuild_step_does_not_require_build_or_push():
    """이 스텝은 이미지 빌드와 무관 — waitFor가 build/push에 안 걸려 있어야(병행 실행,
    #2771 office-converter와 동일 원칙) 배포 지연이 안 생긴다."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-attachments-cors")
    wait_for = step.get("waitFor") or []
    assert not any("build" in w or "push" in w for w in wait_for)
