"""story #2806 — GCS 첨부 버킷 CORS SSOT(infra/gcs-attachments-cors.json + cloudbuild.yaml
apply-gcs-attachments-cors 스텝) 선언 정합성. 순수 정적 검증(실 gcloud 호출 없음) —
"동작은 한 곳에서만 선언" 원칙의 pin(feedback_pin_declarations_as_tests류).

PO 재측정(2026-08-19)으로 라이브 CORS가 애초에 완전 비어있던 게 아니라
(dev-app.sprintable.ai, app.sprintable.ai) 2 origin + 4 responseHeader가 이미 있었음이
드러남 — 신규 JSON은 이 라이브 상태의 "상위집합"이어야 하며(기존 origin/header 유지),
누락분(dev Cloud Run 원시 URL 두 형태)만 추가한다. 전체 교체(overwrite) 특성상 상위집합이
아니면 배포 즉시 회귀다."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CORS_FILE = _REPO_ROOT / "infra" / "gcs-attachments-cors.json"
_CLOUDBUILD = _REPO_ROOT / "cloudbuild.yaml"

# PO 실측 라이브 상태(2026-08-19) — 이 셋이 신규 JSON에서 하나라도 빠지면 침묵 회귀.
_LIVE_ORIGINS = {"https://dev-app.sprintable.ai", "https://app.sprintable.ai"}
_LIVE_RESPONSE_HEADERS = {"Content-Type", "Content-Length", "Content-Disposition", "Range"}

# 이번 story #2806의 실제 결함 표면 — 유나군 실측(AC③ 양성대조) origin.
_DEV_CLOUD_RUN_HASH_ORIGIN = "https://sprintable-frontend-dev-57iommnikq-du.a.run.app"
_DEV_CLOUD_RUN_REGIONAL_ORIGIN = "https://sprintable-frontend-dev-787818285179.asia-northeast3.run.app"


def _load_cors_rules() -> list[dict]:
    return json.loads(_CORS_FILE.read_text())


def _all_origins(rules: list[dict]) -> set[str]:
    return {o for rule in rules for o in rule.get("origin", [])}


def test_cors_file_is_superset_of_live_origins_and_headers():
    """전체 교체 특성 — 라이브에 이미 있던 origin/header가 하나라도 빠지면 배포 즉시 회귀(선생님
    화면이 깨짐). 신규 JSON은 반드시 상위집합이어야 한다."""
    rules = _load_cors_rules()
    all_origins = _all_origins(rules)
    all_headers = {h for rule in rules for h in rule.get("responseHeader", [])}

    missing_origins = _LIVE_ORIGINS - all_origins
    assert not missing_origins, f"라이브 origin 누락(침묵 회귀 위험): {missing_origins}"

    missing_headers = _LIVE_RESPONSE_HEADERS - all_headers
    assert not missing_headers, f"라이브 responseHeader 누락(침묵 회귀 위험): {missing_headers}"


def test_cors_file_includes_dev_cloud_run_origins():
    """story #2806의 실제 결함 표면 — dev Cloud Run 원시 URL이 두 형태(hash형/regional형) 다
    있어야 함. 유나군 실측 origin은 regional형이라 이게 빠지면 AC③ 양성대조가 안 뒤집힌다."""
    all_origins = _all_origins(_load_cors_rules())
    assert _DEV_CLOUD_RUN_HASH_ORIGIN in all_origins
    assert _DEV_CLOUD_RUN_REGIONAL_ORIGIN in all_origins


def test_cors_file_allows_get_for_signed_url_fetch():
    """docx-preview의 client fetch()는 GET — 이게 없으면 CORS를 채워도 여전히 차단된다."""
    rules = _load_cors_rules()
    all_methods = {m for rule in rules for m in rule.get("method", [])}
    assert "GET" in all_methods


def test_cors_file_allows_put_for_signed_upload_and_excludes_options():
    """story #3242(2026-08-31, 유나 실측·페드루 PO 발주) — #886d996f 업로드가 이 버킷에 서명
    PUT을 직접 쏘는데 method가 GET/HEAD뿐이라 프리플라이트가 Access-Control-Allow-Origin
    부재로 net::ERR_FAILED. OPTIONS는 GCS가 Access-Control-Request-Method 매칭으로 자동
    처리하므로 명시하면 안 된다(공식문서: "you shouldn't specify OPTIONS in your CORS
    configuration")."""
    rules = _load_cors_rules()
    all_methods = {m for rule in rules for m in rule.get("method", [])}
    assert "PUT" in all_methods
    assert "OPTIONS" not in all_methods


def test_cors_file_allows_required_put_headers():
    """assets.py create_asset_upload_url이 signed_write_url(create_only=True, content_type=...)
    로 서명해 모든 업로드 PUT에 Content-Type과 x-goog-if-generation-match를 항상 바인딩한다
    (안 보내면 403 SignatureDoesNotMatch). GCS responseHeader는 preflight의
    Access-Control-Allow-Headers에 대응(Expose-Headers 아님) — 여기 없으면 프리플라이트 자체가
    막힌다. Content-Type은 #2806부터 이미 있었으나 x-goog-if-generation-match는 없었다."""
    rules = _load_cors_rules()
    all_headers = {h for rule in rules for h in rule.get("responseHeader", [])}
    assert "Content-Type" in all_headers
    assert "x-goog-if-generation-match" in all_headers


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


def test_cloudbuild_verify_uses_cors_config_field_not_cors():
    """`gcloud storage buckets describe --format=value(cors)`는 존재하지 않는 필드라 항상
    빈 값을 준다(PO가 실측으로 잡은 오측) — 실 필드명은 cors_config."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-attachments-cors")
    script = step["args"][1]
    assert "cors_config" in script
    assert "value(cors)" not in script


def test_cloudbuild_verify_fails_closed_when_expected_origin_missing():
    """검증 echo가 항상 통과하면 확認이 아니다 — 기대 origin(dev Cloud Run regional, 유나군
    실측 표면)이 적용 결과에 없으면 스텝이 exit 1로 죽어야 한다."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-attachments-cors")
    script = step["args"][1]
    assert _DEV_CLOUD_RUN_REGIONAL_ORIGIN in script
    assert "exit 1" in script


def test_cloudbuild_step_does_not_require_build_or_push():
    """이 스텝은 이미지 빌드와 무관 — waitFor가 build/push에 안 걸려 있어야(병행 실행,
    #2771 office-converter와 동일 원칙) 배포 지연이 안 생긴다."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-attachments-cors")
    wait_for = step.get("waitFor") or []
    assert not any("build" in w or "push" in w for w in wait_for)
