"""story #3545 — GCS 채널 미디어 버킷 CORS SSOT(infra/gcs-channel-media-cors.json +
cloudbuild.yaml apply-gcs-channel-media-cors 스텝) 선언 정합성. test_2806_gcs_
attachments_cors_ssot.py와 같은 형(순수 정적 검증, 실 gcloud 호출 없음).

원 결함: 이 json이 attachments json에서 복사됐을 때(#3776/3425, 버킷 신설)
#3242가 이미 겪은 교훈(서명 create-only PUT은 x-goog-if-generation-match를
responseHeader에 요구)이 안 옮겨졌다 — 에디터 브라우저 이미지 첨부 preflight가
막혔다(유나 라이브 실측 2026-09-06). 적용 스텝 검증도 origin만 보고 헤더는
안 봐서 이 회귀가 배포 로그에서 초록으로 지나갔다.

이 파일이 pin하는 것 / 못 잡는 것:
- pin: json 선언과 cloudbuild 스텝 선언의 정합성(정적 파일 내용).
- 못 잡는 것: 실제 GCS 버킷에 적용된 라이브 CORS 상태(gcloud 호출 없음 — 그건
  cloudbuild 배포 스텝 자체의 실행 시점 검증(exit 1 게이트)이 진다), 버킷 밖
  요인(CSP connect-src·서명 URL 만료·CDN 캐시된 구 preflight 응답 등)."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from tests.gcs_cors_ssot_helpers import assert_cors_file_allows_required_write_headers

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CORS_FILE = _REPO_ROOT / "infra" / "gcs-channel-media-cors.json"
_CLOUDBUILD = _REPO_ROOT / "cloudbuild.yaml"

_DEV_CLOUD_RUN_REGIONAL_ORIGIN = "https://sprintable-frontend-dev-787818285179.asia-northeast3.run.app"


def _load_cors_rules() -> list[dict]:
    return json.loads(_CORS_FILE.read_text())


def test_cors_file_allows_put_and_excludes_options():
    """story 620beefc/#3538이 이 버킷에 서명 PUT을 직접 쏜다. OPTIONS는 GCS가
    Access-Control-Request-Method 매칭으로 자동 처리하므로 명시하면 안 된다."""
    rules = _load_cors_rules()
    all_methods = {m for rule in rules for m in rule.get("method", [])}
    assert "PUT" in all_methods
    assert "OPTIONS" not in all_methods


def test_cors_file_allows_required_write_headers():
    """story #3545의 실제 결함 표면 — channel_post_images.py:208이
    provider.required_write_headers(create_only=True)로 서명해 모든 업로드 PUT에
    그 헤더(GCS=x-goog-if-generation-match)를 항상 바인딩한다. 여기 없으면
    프리플라이트 자체가 막힌다(#3242와 같은 클래스, 다른 버킷)."""
    assert_cors_file_allows_required_write_headers(_CORS_FILE)


def test_cloudbuild_apply_step_references_the_cors_file_exactly():
    """⭐선언 정합성 — apply-gcs-channel-media-cors 스텝이 참조하는 --cors-file
    경로가 실제 이 파일과 정확히 일치하는지(파일명 드리프트 방지)."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next((s for s in doc["steps"] if s["id"] == "apply-gcs-channel-media-cors"), None)
    assert step is not None, "cloudbuild.yaml에 apply-gcs-channel-media-cors 스텝이 없음"
    assert step["entrypoint"] == "bash"
    script = step["args"][1]
    assert "infra/gcs-channel-media-cors.json" in script
    assert "gcloud storage buckets update" in script


def test_cloudbuild_verify_checks_origin_and_header_fails_closed():
    """story #3545 — 원 결함의 핵심: 이 스텝의 검증이 origin만 보고 헤더 누락은
    그냥 지나쳤다. 이제 둘 다 없으면 exit 1로 죽어야 한다(기대 origin·기대 헤더
    문자열이 스크립트 자체에 있고, 각각 실패 분기에 exit 1이 있는지 pin)."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-channel-media-cors")
    script = step["args"][1]
    assert _DEV_CLOUD_RUN_REGIONAL_ORIGIN in script
    assert "x-goog-if-generation-match" in script
    assert script.count("exit 1") >= 2


def test_cloudbuild_step_skips_on_prod():
    """story 620beefc — channel-media 버킷은 dev 전용(prod 미프로비저닝). prod에서
    이 스텝이 gcloud를 실제로 호출하면 존재하지 않는 버킷 대상으로 실패한다 —
    조기 skip이 있어야 한다."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-channel-media-cors")
    script = step["args"][1]
    assert '_DEPLOY_ENV}" == "prod"' in script
    assert "skip" in script.lower()


def test_cloudbuild_step_does_not_require_build_or_push():
    """이미지 빌드와 무관 — waitFor가 build/push에 안 걸려 있어야 배포 지연이 안 생긴다."""
    doc = yaml.safe_load(_CLOUDBUILD.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "apply-gcs-channel-media-cors")
    wait_for = step.get("waitFor") or []
    assert not any("build" in w or "push" in w for w in wait_for)
