"""story #4072(E-RECIPE-1, 페드루 PO 確定 2026-09-19) — `sealed_*` ORM 컬럼 응답스키마 누락
회귀가드. gates.py 자신의 주석이 이미 이 버그클래스를 2회(sealed_ads_*·sealed_newsletter_*)
자백하고 있었고, `sealed_estimated_cost_minor`(story #4044/0333)가 3번째 재발이었다 — 컬럼
추가는 되는데 `GateResponse`(응답 Pydantic 모델) 등재를 빠뜨려 API가 항상 None을 내는 클래스.

순수 정적 검사(DB 접속 불요) — `Gate` ORM의 모든 `sealed_*` 컬럼이 `GateResponse`
(model_config=ConfigDict(from_attributes=True))에 같은 이름으로 선언돼 있는지 대조한다.
단, `sealed_scheduled_at`/`sealed_media_sha256`/`sealed_ads_boost_version_id`/
`sealed_newsletter_version_id` 4개는 **의도적으로 응답에 안 낸다**(재승인 판정축·
publication_command 멱등키 등 순수 내부 비교용 — gate.py 자체 주석이 "site_posts 등은
이 컬럼을 절대 안 씀"/"FE가 읽지 않는다" 부류로 명시한 자리) — 이 예외는 화이트리스트로
명시하고, 새 `sealed_*` 컬럼이 이 화이트리스트에도 GateResponse에도 없으면 가드가 즉시 잡는다.

revert-confirm(PO AC4) — 구현 중 `sealed_estimated_cost_minor` 필드 선언을 일시 주석
처리하고 이 가드가 실제로 FAIL하는지 수동 확認했다(PR 본문에 기록, 이 파일 자체엔
그 상태를 남기지 않는다 — 커밋본은 항상 GREEN이어야 하므로)."""
from __future__ import annotations

# story #4072 AC4 — 의도적 응답 제외 화이트리스트. 새 항목을 추가할 땐 반드시 "왜 이
# 컬럼은 API에 안 내는지"를 gate.py(모델) 쪽 주석에 먼저 남기고, 그 근거를 여기 한 줄로
# 요약해 둘 것 — 근거 없는 침묵 추가를 막는다(조용히 목록만 늘리는 것 자체가 이 가드의
# 존재 이유를 무력화한다).
_INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS: frozenset[str] = frozenset({
    # story #3414/620beefc/e4fc29fa — external_publish 재승인 판정축(schedule/media/
    # destination changed 비교용). FE가 안 읽음, site_posts.py 등은 이 컬럼을 안 씀.
    "sealed_scheduled_at",
    "sealed_media_sha256",
    # story #3813 — ads_boost/newsletter_send publication_command 멱등키(approved_version
    # 축, 매 재봉인마다 서비스가 새 UUID 발급) — 순수 서버 내부 비교값, API 노출 대상 아님.
    "sealed_ads_boost_version_id",
    "sealed_newsletter_version_id",
})


def test_every_gate_sealed_column_is_either_exposed_or_explicitly_whitelisted():
    """AC4 — Gate 모델의 모든 sealed_* ORM 컬럼이 GateResponse 필드 또는 위 화이트리스트
    둘 중 하나엔 반드시 있어야 한다. 어느 쪽에도 없으면(=신규 컬럼 추가하고 둘 다 깜빡)
    즉시 RED — sealed_estimated_cost_minor류 재발을 이 시점에 잡는다."""
    from app.models.gate import Gate
    from app.routers.gates import GateResponse

    orm_sealed_columns = {
        col.name for col in Gate.__table__.columns if col.name.startswith("sealed_")
    }
    response_fields = set(GateResponse.model_fields.keys())

    missing = orm_sealed_columns - response_fields - _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS
    assert missing == set(), (
        f"Gate의 sealed_* 컬럼이 GateResponse에도 화이트리스트에도 없다: {sorted(missing)} — "
        "새 sealed_* 컬럼을 추가했으면 GateResponse에 등재하거나(API로 노출), 의도적으로 "
        "내부 전용이면 _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS에 근거와 함께 추가할 것 "
        "(story #4072 — sealed_ads_*/sealed_newsletter_*에 이어 3번째 재발이었던 클래스)."
    )


def test_whitelist_entries_are_still_real_gate_columns():
    """화이트리스트 자체가 stale해지는 것 방지 — 컬럼이 리네임/삭제됐는데 화이트리스트만
    남으면 그 항목은 조용히 아무것도 안 거르는 죽은 엔트리가 된다."""
    from app.models.gate import Gate

    orm_columns = {col.name for col in Gate.__table__.columns}
    stale = _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS - orm_columns
    assert stale == set(), f"화이트리스트에 있지만 더 이상 Gate 컬럼이 아닌 항목: {sorted(stale)}"


def test_sealed_estimated_cost_minor_is_exposed_in_gate_response():
    """AC1 최소 실증 — 이번 스토리의 구체적 대상 필드가 실제로 GateResponse에 선언돼
    있는지 직접 단언(위 전수 가드와 별개로, 이 필드 하나를 못박는다)."""
    from app.routers.gates import GateResponse

    assert "sealed_estimated_cost_minor" in GateResponse.model_fields
