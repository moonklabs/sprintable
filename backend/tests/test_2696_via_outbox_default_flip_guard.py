"""story #2696([클래스 마감]) — dispatch_notification의 via_outbox 기본값을 True로 뒤집었다
(#2687→#2688→#373cfaa1→#2694로 4번 반복된 "호출부 트랜잭션 안 동기 webhook POST" 결함의
근본원인이 "기본값이 동기"인 것 자체였다는 판단, AC1 그라운딩으로 동기 완료 전제 호출부 0건
확認 후 승인).

이 파일은 두 축을 고정한다:
①signature 축 — 기본값 자체가 True인지(다시 뒤집혀도 즉시 RED).
②count-lock 축 — backend 전역에서 ``via_outbox=False``를 «명시»하는 자리가 늘지 않는지
(현재 0곳 — 늘면 그 자리에 사유 주석과 함께 이 baseline을 의식적으로 올려야 한다)."""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

_BACKEND_APP = Path(__file__).resolve().parent.parent / "app"
_BACKEND_EE = Path(__file__).resolve().parent.parent / "ee"

# count-lock baseline — 의식적으로만 올린다(늘어나면 왜 필요한지 사유 주석을 그 콜사이트에 남길 것).
_EXPLICIT_SYNC_OPT_OUT_BASELINE = 0


def _find_explicit_via_outbox_false(root: Path) -> list[str]:
    """AST 기반 — ``via_outbox=False`` 키워드 인자를 넘기는 호출을 전부 찾는다(토큰경계 안전 —
    substring grep이 아니라 실제 AST Call 노드의 keyword만 본다)."""
    hits: list[str] = []
    for path in sorted(root.rglob("*.py")):
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for kw in node.keywords:
                if kw.arg == "via_outbox" and isinstance(kw.value, ast.Constant) and kw.value.value is False:
                    hits.append(f"{path.relative_to(root.parent)}:{node.lineno}")
    return hits


def test_dispatch_notification_default_via_outbox_is_true():
    """signature 축 — mock을 어떻게 짜든 이 한 줄이 기본값 회귀를 직접 잡는다."""
    from app.services.notification_dispatch import dispatch_notification

    default = inspect.signature(dispatch_notification).parameters["via_outbox"].default
    assert default is True, (
        "dispatch_notification(via_outbox=...) 기본값이 True가 아니다 — story #2696 flip이 "
        "되돌려졌다(#2687/#2688/#373cfaa1/#2694와 같은 클래스 재발 위험)."
    )


def test_deliver_personal_webhooks_default_via_outbox_is_true():
    from app.services.notification_dispatch import _deliver_personal_webhooks

    default = inspect.signature(_deliver_personal_webhooks).parameters["via_outbox"].default
    assert default is True


def test_deliver_expo_push_default_via_outbox_is_true():
    from ee.services.expo_push import deliver_expo_push

    default = inspect.signature(deliver_expo_push).parameters["via_outbox"].default
    assert default is True


def test_no_new_explicit_sync_opt_out_call_sites():
    """count-lock 축 — backend/app·backend/ee 전역에서 via_outbox=False 명시 호출이 baseline(0)을
    넘지 않는지 고정. mutation-kill: 아무 콜사이트에 via_outbox=False를 추가하면 이 테스트가
    RED가 된다(직접 확인 — 임시로 fixture 파일에 추가해 재현)."""
    hits = _find_explicit_via_outbox_false(_BACKEND_APP) + _find_explicit_via_outbox_false(_BACKEND_EE)
    assert len(hits) == _EXPLICIT_SYNC_OPT_OUT_BASELINE, (
        f"via_outbox=False 명시 호출이 baseline({_EXPLICIT_SYNC_OPT_OUT_BASELINE})을 벗어났다: {hits}\n"
        "동기가 정말 필요하면 그 콜사이트에 사유 주석을 남기고 이 baseline을 의식적으로 올릴 것."
    )


def test_ast_scan_catches_explicit_false_fixture():
    """AST 스캐너 자체의 양성대조 — 실제로 via_outbox=False를 넘기는 코드가 있으면 잡히는지
    고정 fixture 소스로 검증(스캐너가 무력화돼 위 count-lock이 공허통과하는 것 방지)."""
    import tempfile

    fixture_src = (
        "async def f():\n"
        "    await dispatch_notification(db, org_id=x, event_type='y', "
        "target_member_ids=[], title='t', via_outbox=False)\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "fixture_mod.py").write_text(fixture_src, encoding="utf-8")
        hits = _find_explicit_via_outbox_false(tmp_path)
    assert len(hits) == 1
