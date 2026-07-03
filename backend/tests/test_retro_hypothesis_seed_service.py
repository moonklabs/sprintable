"""E-SPRINT-LOOP ecc531ce: retro_hypothesis_seed 서비스 단위 테스트.

resolve_next_sprint(§2 PO 결: planning 중 가장 이른 start_date/created_at)와
find_candidate(shape 검증 겸용 탐색)의 순수 로직만 — DB 연결/실 hypothesis 생성은
realdb 스위트(test_e_sprint_loop_ecc531ce_*.py)에서."""
import uuid

import pytest

from app.services import retro_hypothesis_seed as svc

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── find_candidate ────────────────────────────────────────────────────────────

def test_find_candidate_matches_by_id():
    cid = uuid.uuid4()
    items = [{"id": str(cid), "statement": "s"}, {"id": str(uuid.uuid4()), "statement": "x"}]
    result = svc.find_candidate(items, cid)
    assert result == items[0]


def test_find_candidate_not_found_returns_none():
    assert svc.find_candidate([{"id": str(uuid.uuid4())}], uuid.uuid4()) is None


def test_find_candidate_none_next_hypotheses_returns_none():
    assert svc.find_candidate(None, uuid.uuid4()) is None


def test_find_candidate_not_a_list_returns_none():
    """malformed 캐시(dict/str 등) — 안전하게 None(라우터가 404로 처리)."""
    assert svc.find_candidate({"learned": []}, uuid.uuid4()) is None
    assert svc.find_candidate("not a list", uuid.uuid4()) is None


def test_find_candidate_skips_non_dict_items():
    cid = uuid.uuid4()
    items = [123, "x", {"id": str(cid), "statement": "s"}]
    result = svc.find_candidate(items, cid)
    assert result == {"id": str(cid), "statement": "s"}
