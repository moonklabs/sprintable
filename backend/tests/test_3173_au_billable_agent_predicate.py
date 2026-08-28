"""story #3173(결제②-B) — `is_au_billable_agent()` 판별자 회귀(페드루 PO §2 조건).

doc `pricing-policy-proposal-v1` §4.5: "사람이 웹 UI에서 수행한 작업 = 0 AU". 판별자가
`api_key_id` claim 존재만 보면 `_resolve_human_api_key`(hu_live_*, 휴먼 개인 API key —
`"human_api_key_id"`로 싣고 `"actor_type": "human"`을 명시하는 기존 경로)를 에이전트로
오분류할 위험이 있다 — 이 케이스가 AU=0으로 남는 것을 값으로 고정한다."""
from __future__ import annotations

from app.dependencies.auth import AuthContext, is_au_billable_agent


def _ctx(app_metadata: dict) -> AuthContext:
    return AuthContext(user_id="u1", email=None, claims={"app_metadata": app_metadata}, org_id="org1")


def test_human_personal_api_key_is_not_au_billable():
    """_resolve_human_api_key()가 실제로 만드는 claims 형태 그대로(hu_live_* 경로)."""
    ctx = _ctx({"human_api_key_id": "key-1", "actor_type": "human"})
    assert is_au_billable_agent(ctx) is False


def test_agent_api_key_is_au_billable():
    """_resolve_api_key()가 만드는 claims 형태(sk_live_* 경로, api_key_id 존재·actor_type 없음)."""
    ctx = _ctx({"api_key_id": "key-2", "org_id": "org1"})
    assert is_au_billable_agent(ctx) is True


def test_api_key_id_present_but_explicitly_marked_human_is_not_billable():
    """방어적 케이스 — api_key_id가 있어도 actor_type="human"이 명시되면 항상 사람 취급
    (판별자 문서화된 근거를 실제로 지키는지 값으로 고정)."""
    ctx = _ctx({"api_key_id": "key-3", "actor_type": "human"})
    assert is_au_billable_agent(ctx) is False


def test_plain_human_jwt_without_api_key_claim_is_not_billable():
    """일반 사람 JWT(app_metadata에 api_key_id 자체가 없음)도 당연히 비과금."""
    ctx = _ctx({"org_id": "org1"})
    assert is_au_billable_agent(ctx) is False
