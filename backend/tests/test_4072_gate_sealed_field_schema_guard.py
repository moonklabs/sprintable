"""story #4072(E-RECIPE-1, 페드루 PO 確定 2026-09-19) — `sealed_*` ORM 컬럼 응답스키마 누락
회귀가드. gates.py 자신의 주석이 이미 이 버그클래스를 2회(sealed_ads_*·sealed_newsletter_*)
자백하고 있었고, `sealed_estimated_cost_minor`(story #4044/0333)가 3번째 재발이었다 — 컬럼
추가는 되는데 `GateResponse`(응답 Pydantic 모델) 등재를 빠뜨려 API가 항상 None을 내는 클래스.

순수 정적 검사(DB 접속 불요) — `Gate` ORM의 모든 `sealed_*` 컬럼이 `GateResponse`
(model_config=ConfigDict(from_attributes=True))에 같은 이름으로 선언돼 있는지 대조한다.
`sealed_media_sha256`/`sealed_ads_boost_version_id`/`sealed_newsletter_version_id` 3개는
순수 내부 비교값(해시·멱등키 — 사람에게 보일 값 자체가 없다, 화이트리스트 참고).

⚠️정정(카디르 QA④, 2026-09-19, 페드루 PO 정정 反映) — 최초 제출본은 `sealed_scheduled_at`도
같은 "의도적 내부전용" 화이트리스트에 넣었으나 **근거가 틀렸다**: 이 값은 `channel_posts.py`
의 draft/campaign 응답(`campaign_scheduled_at`·`scheduled_at` 필드, 1347/1778줄)에는 **이미
노출되고 있다** — 단지 범용 `GateResponse`(gate-evidence.tsx 승인카드가 읽는 그 자리)에만
없다. `newsletter_send` 게이트의 동형 필드(`sealed_newsletter_scheduled_at`)는 승인카드에
이미 뜨는데 `external_publish`(예약 발행) 게이트만 그 자리에 예약시각이 안 보이는 진짜 실
불일치다 — "의도적"이라 못박으면 이 갭을 영구 고정시킨다. 그래서 아래에서 별도 집합
(`_KNOWN_GAP_DEFERRED_TO_FOLLOWUP`)으로 분리했다 — 의도적 설계가 아니라 "실 결함, 다만
이 PR(estimated_cost 전용, 페드루 PO 스코프 확定)에선 안 고치고 후속 스토리로 미룬다"는
사실을 그대로 남긴다. 이 가드가 당장 GREEN이려면 어느 한쪽 집합엔 있어야 하지만, 그
소속이 "의도적"과 "결함(추적中)"을 구분해야 다음 사람이 또 속지 않는다.

revert-confirm(PO AC4) — 구현 중 `sealed_estimated_cost_minor` 필드 선언을 일시 주석
처리하고 이 가드가 실제로 FAIL하는지 수동 확認했다(PR 본문에 기록, 이 파일 자체엔
그 상태를 남기지 않는다 — 커밋본은 항상 GREEN이어야 하므로)."""
from __future__ import annotations

# story #4072 AC4 — 의도적 응답 제외 화이트리스트. 새 항목을 추가할 땐 반드시 "왜 이
# 컬럼은 API에 안 내는지"를 gate.py(모델) 쪽 주석에 먼저 남기고, 그 근거를 여기 한 줄로
# 요약해 둘 것 — 근거 없는 침묵 추가를 막는다(조용히 목록만 늘리는 것 자체가 이 가드의
# 존재 이유를 무력화한다). 진짜로 사람에게 보일 값이 없는 것만 여기 둔다.
_INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS: frozenset[str] = frozenset({
    # story 620beefc — external_publish 재승인 판정축(이미지 교체 비교용). 해시값이라
    # 그 자체로 사람에게 보일 의미가 없다 — site_posts.py 등 어떤 응답에도 노출 0건.
    "sealed_media_sha256",
    # story #3813 — ads_boost/newsletter_send publication_command 멱등키(approved_version
    # 축, 매 재봉인마다 서비스가 새 UUID 발급) — 순수 서버 내부 비교값, API 노출 대상 아님.
    "sealed_ads_boost_version_id",
    "sealed_newsletter_version_id",
})

# 카디르 QA④(2026-09-19) — 위 화이트리스트와 다른 성격. "노출 안 해도 되는 값"이 아니라
# "노출돼야 하는데 아직 GateResponse에 없는 실 결함"이다(channel_posts.py의 draft/
# campaign 응답에는 이미 노출 中 — campaign_scheduled_at/scheduled_at 필드, 1347/1778줄
# — 범용 GateResponse에만 빠져 승인카드에서 예약 발행 시각이 안 보인다). 이 PR(#4072)
# 스코프는 estimated_cost 전용(페드루 PO 確定)이라 여기서 같이 안 고친다 — 대신 별도
# 결함으로 등재해 GREEN을 유지하되 "의도적"이라고 거짓말하지 않는다. 후속 스토리가
# GateResponse에 등재하면 이 집합에서 빼고 다시 실행 — 전수 가드가 그 컬럼이 이제
# response_fields에 있다고 통과하니 별도 유지보수 테스트는 불요(가드 자체가 자기갱신).
_KNOWN_GAP_DEFERRED_TO_FOLLOWUP: frozenset[str] = frozenset({
    # external_publish 예약시각 승인카드 노출 — 미르코가 PR#4450 리뷰에서 제안, 페드루
    # PO가 별도 스토리로 열 예정(2026-09-19 시점 story 번호 미배정). 배정되면 이 주석에
    # 번호를 채울 것.
    "sealed_scheduled_at",
})


def test_every_gate_sealed_column_is_either_exposed_or_explicitly_whitelisted():
    """AC4 — Gate 모델의 모든 sealed_* ORM 컬럼이 GateResponse 필드 또는 위 두 집합
    (의도적 내부전용/추적中인 결함) 중 하나엔 반드시 있어야 한다. 어느 쪽에도 없으면
    (=신규 컬럼 추가하고 다 깜빡) 즉시 RED — sealed_estimated_cost_minor류 재발을
    이 시점에 잡는다."""
    from app.models.gate import Gate
    from app.routers.gates import GateResponse

    orm_sealed_columns = {
        col.name for col in Gate.__table__.columns if col.name.startswith("sealed_")
    }
    response_fields = set(GateResponse.model_fields.keys())

    missing = (
        orm_sealed_columns - response_fields
        - _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS - _KNOWN_GAP_DEFERRED_TO_FOLLOWUP
    )
    assert missing == set(), (
        f"Gate의 sealed_* 컬럼이 GateResponse·화이트리스트·추적中 결함 목록 어디에도 없다: "
        f"{sorted(missing)} — 새 sealed_* 컬럼을 추가했으면 GateResponse에 등재하거나(API로 "
        "노출), 진짜 내부 전용이면 _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS에, 노출은 돼야 "
        "하는데 지금 스코프가 아니면 _KNOWN_GAP_DEFERRED_TO_FOLLOWUP에 스토리 번호와 함께 "
        "추가할 것(story #4072 — sealed_ads_*/sealed_newsletter_*에 이어 3번째 재발이었던 "
        "클래스)."
    )


def test_whitelist_entries_are_still_real_gate_columns():
    """두 목록 다 stale해지는 것 방지 — 컬럼이 리네임/삭제됐는데 목록만 남으면 그 항목은
    조용히 아무것도 안 거르는 죽은 엔트리가 된다."""
    from app.models.gate import Gate

    orm_columns = {col.name for col in Gate.__table__.columns}
    stale = (
        _INTENTIONALLY_UNEXPOSED_SEALED_COLUMNS | _KNOWN_GAP_DEFERRED_TO_FOLLOWUP
    ) - orm_columns
    assert stale == set(), f"목록에 있지만 더 이상 Gate 컬럼이 아닌 항목: {sorted(stale)}"


def test_sealed_estimated_cost_minor_is_exposed_in_gate_response():
    """AC1 최소 실증 — 이번 스토리의 구체적 대상 필드가 실제로 GateResponse에 선언돼
    있는지 직접 단언(위 전수 가드와 별개로, 이 필드 하나를 못박는다)."""
    from app.routers.gates import GateResponse

    assert "sealed_estimated_cost_minor" in GateResponse.model_fields
