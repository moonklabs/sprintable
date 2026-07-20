"""story #1951 (E-MOBILE P1a-S1): 딥링크 계약 매니페스트 v1 — 서빙 엔드포인트.

PO 재정(3자 검토 스코프 확장): 매니페스트는 정적 파일이 아니라 런타임 API여야 한다(미르코,
FE 소비 오너) — 모바일 앱이 콜드스타트/포그라운드 복귀 시 이 엔드포인트로 최신 SSOT를
받아온다. read-only, org 비스코프(레지스트리 자체는 org와 무관한 전역 상수) — 인증된
호출자면 누구나 조회 가능.

SSOT = `app.schemas.deeplink_manifest.DEEPLINK_MANIFEST`. 이 라우터는 그걸 JSON으로
직렬화만 한다(레지스트리 로직/불변식 검증은 스키마 모듈이 이미 model_validator로 강제).
"""
from fastapi import APIRouter, Depends

from app.dependencies.auth import AuthContext, get_current_user
from app.schemas.deeplink_manifest import DEEPLINK_MANIFEST, MANIFEST_SCHEMA_VERSION

router = APIRouter(prefix="/api/v2", tags=["deeplink-manifest", "Organization"])

# 미르코(FE 소비 오너) point ③: MAJOR 버전 불일치 시 클라이언트 안전 폴백 계약. 서버가
# 강제할 수 있는 건 이 필드를 응답에 명확히 노출하는 것까지 — 실제 "내 지원 MAJOR와 다르면
# 로컬 SSOT로 폴백" 판단/구현은 클라이언트(P1b) 몫이다.
VERSION_POLICY = (
    "이 매니페스트를 소비하는 클라이언트는 자신이 지원하는 schema_version(MAJOR)과 이 "
    "응답의 schema_version이 다르면(특히 응답 값이 더 높으면) 이 응답을 신뢰하지 말고 "
    "클라이언트에 번들된 로컬 SSOT 사본으로 폴백해야 한다. PATCH 수준 변경(신규 엔트리 "
    "추가·설명 문구 변경)은 schema_version을 올리지 않으므로 구버전 클라이언트도 안전하게 "
    "소비 가능하다 — MAJOR bump는 Layer 1 필드(target 값 체계·parentTab enum·"
    "returnPolicy 의미) 변경 시에만 발생한다."
)


def _serialize_entry(entry) -> dict:
    """엔트리 1개 직렬화. 미르코 point ①(nested 구조·snake_case)은 유지 — 기존
    app/payload/channel 3-레이어 nested dict 그대로. point ②: lookup_key 필드만
    서빙 시점에 파생 추가(내부 튜플 키(type, entity_type)는 그대로 두고 서빙 JSON에서만
    문자열화)."""
    data = entry.model_dump(mode="json")
    entity_type = entry.app.entity_type or ""
    data["lookup_key"] = f"{entry.app.type}:{entity_type}"
    return data


@router.get("/deeplink-manifest")
async def get_deeplink_manifest(_: AuthContext = Depends(get_current_user)) -> dict:
    """GET /api/v2/deeplink-manifest — 딥링크 계약 매니페스트 v1 (read-only, 전역 SSOT).

    응답 형태:
        {
          "schema_version": 1,
          "version_policy": "<MAJOR 불일치 시 폴백 계약 설명>",
          "entries": [{"lookup_key": "dispatched:story", "app": {...}, "payload": {...},
                       "channel": {...}}, ...]
        }
    """
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "version_policy": VERSION_POLICY,
        "entries": [_serialize_entry(e) for e in DEEPLINK_MANIFEST.entries],
    }
