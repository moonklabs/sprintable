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

# 2026-07-21(오르테가 PO 확認 요청): target_promotion_pending 뜻이 지금까지 BE 소스의
# Pydantic Field(description=...)에만 있었고(스키마 모듈 코드를 읽어야만 알 수 있었다),
# 실제 응답 payload 어디에도 소비자가 읽을 수 있는 형태로 없었다 — VERSION_POLICY와
# 동일하게 여기서도 응답 자체에 명시한다.
TARGET_PROMOTION_PENDING_POLICY = (
    "entries[].app.target_promotion_pending가 true인 엔트리는 target이 가리키는 화면이 "
    "이 클라이언트 플랫폼에는 아직 전용 라우트로 존재하지 않는 잠정/폴백 상태임을 뜻한다. "
    "target 문자열 자체는 유효한 의미 식별자다(장차 승격될 실제 화면 이름) — 클라이언트는 "
    "이 값을 조건부로 해석(예: URL 조립)하지 말고, 그 화면이 아직 없으면 자신의 현재 "
    "최선의 대체 착지(상위 화면 등)로 매핑하거나 AC4 안전 폴백(`지금` 탭)을 적용해야 한다. "
    "승격되면(전용 라우트 신설) 이 플래그가 false로 바뀌고 클라이언트는 정식 매핑을 쓴다."
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
          "target_promotion_pending_policy": "<target_promotion_pending 플래그 뜻 설명>",
          "entries": [{"lookup_key": "dispatched:story", "app": {...}, "payload": {...},
                       "channel": {...}}, ...]
        }
    """
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "version_policy": VERSION_POLICY,
        "target_promotion_pending_policy": TARGET_PROMOTION_PENDING_POLICY,
        "entries": [_serialize_entry(e) for e in DEEPLINK_MANIFEST.entries],
    }
