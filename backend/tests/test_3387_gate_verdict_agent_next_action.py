"""story #3387(결함·오도 문구, PO 2026-09-03 13:33Z 스코프 확定) — 담롱 온찬 실사례 5건
(2026-09-03) 전부 `_render_gate_verdict_message`(agent-only MCP 표면)의 옛 문구와 문자
그대로 일치했다: verdict만 보고 gate_type을 안 봐 approved에 제품에 없는 «발행 도구»를
권했고(사례 1~4), «폐기 대상» rejected에 재상신을 권해 결정과 정반대 행동을 시켰다(사례 5).

여기서는 `_render_gate_verdict_message`를 mock db(실 Postgres 없이)로 직접 호출해 새
gate_type=external_publish 분기만 좁게 잰다 — 실전 통합 경로(발행→work item assignee
도달)는 test_3330_gate_verdict_notification.py가 이미 realdb로 덮는다.

AC5 — 뮤테이션: has_discontinue_signal 호출을 지우면 "사례 5" 테스트가 RED로 바뀐다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeGateRow:
    def __init__(self, neutral_facts: dict | None, *, id_=None):
        self.neutral_facts = neutral_facts
        self.id = id_ or uuid.uuid4()


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row

    def one_or_none(self):
        return self._row

    def first(self):
        return self._row


def _fake_db(
    gate_row=None, *, site_post_draft_exists: bool = False,
    site_post_command_exists: bool = False,
):
    """story #3487 — SitePostDraft 존재 조회(verdict==approved·draft_id 있을 때만
    일어난다)를 Gate 조회와 다르게 응답해야 한다 — 쿼리가 겨누는 테이블로 직접
    가른다(호출 순서·개수에 안 기댄다, story #3369 후속 교정 재사용: payload에
    gate_id가 있으면 db.get(Gate, ...)이 gate row를 얻어 execute를 아예 안 타므로
    call-count 가정은 그 경로에서 깨진다). `db.get(Gate, ...)`(gate_id 있는 신규
    경로)도 같은 gate_row를 돌려준다.

    story #4155 유나 CHANGES(2026-09-10) — connection_id 유무 대리값(#3369 후속의
    최초 처방)을 버리고 실제 `PublicationCommand` 존재 여부를 직접 조회하는 걸로
    바뀌었다(`gate_service.py`의 6개 조용한 return 경로가 "external인데 명령 없음"을
    만들 수 있어 그 대리값이 틀렸었다). 세 번째 쿼리 대상(publication_commands)도
    따로 흉내낸다."""
    db = AsyncMock()

    async def _execute(query, *_args, **_kwargs):
        q = str(query)
        if "site_post_drafts" in q:
            return _FakeResult(uuid.uuid4() if site_post_draft_exists else None)
        if "publication_commands" in q:
            return _FakeResult(uuid.uuid4() if site_post_command_exists else None)
        return _FakeResult(gate_row)

    db.execute = AsyncMock(side_effect=_execute)
    db.get = AsyncMock(return_value=gate_row)
    return db


def _payload(
    *, gate_type: str, verdict: str, resolution_note: str | None = None, gate_id: str | None = None,
) -> dict:
    payload = {
        "work_item_type": "story",
        "work_item_id": str(uuid.uuid4()),
        "gate_type": gate_type,
        "verdict": verdict,
        "resolution_note": resolution_note,
    }
    if gate_id:
        payload["gate_id"] = gate_id
    return payload


@pytest.fixture(autouse=True)
def _stub_work_item_ref(monkeypatch):
    from app.routers import events as events_module

    async def _fake_ref(*_args, **_kwargs):
        return "[제목](entity:story:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_render_event_notification_work_item_ref", _fake_ref)


async def _render(
    payload: dict, gate_row=None, *, site_post_draft_exists: bool = False,
    site_post_command_exists: bool = False,
) -> str:
    from app.routers.events import _render_gate_verdict_message

    return await _render_gate_verdict_message(
        _fake_db(
            gate_row, site_post_draft_exists=site_post_draft_exists,
            site_post_command_exists=site_post_command_exists,
        ),
        org_id=uuid.uuid4(), payload=payload,
    )


class TestExternalPublishAgentNextAction:
    async def test_approved_gives_no_task_text_not_publish_tool(self):
        # 사례 1~4 — 승인 카드가 제품에 없는 «발행 도구»를 더 이상 권하지 않는다.
        text = await _render(_payload(gate_type="external_publish", verdict="approved"))
        assert "발행 도구" not in text
        assert "- 다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다." in text

    async def test_rejected_with_discontinue_signal_has_no_next_action_line_at_all(self):
        # 사례 5 — 「발행 금지·폐기 대상」으로 반려했는데 재상신을 권하던 모순을 없앤다.
        # 침묵도 문구다: "다음 행동" 줄 자체가 없어야 한다(빈 값이 아니라 렌더 자체 없음).
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="발행 금지·폐기 대상",
        ))
        assert "다음 행동" not in text
        assert "자동 재오픈" not in text
        assert "다시 발행하세요" not in text

    async def test_rejected_without_signal_gives_no_task_text_not_a_directive(self):
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="제목 오타 수정 필요",
        ))
        assert "- 다음 행동: 할 일 없음 — 다시 올릴지는 작성자가 정합니다." in text

    async def test_site_post_external_destination_approved_says_worker_tick_not_human_screen(self):
        """story #3487 — site_post 외부 목적지(WordPress 등)는 승인 즉시 워커가
        다음 tick에 발행한다(실동작). draft_id가 site_post_drafts에 있고 실제
        PublicationCommand도 있으면(gate_service.py가 정상적으로 명령을 만든 경우)
        새 문구."""
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"),
            gate_row=gate_row, site_post_draft_exists=True, site_post_command_exists=True,
        )
        assert "발행은 휴먼이 화면에서 합니다" not in text
        assert "다음 워커 tick" in text
        assert "발행 결과" in text

    async def test_site_post_hosted_site_approved_keeps_human_screen_text(self):
        """story #3369 후속(자기점검 2차, 2026-09-10) — hosted_site는 #3487 옛
        주석이 틀리게 "공통"이라 적었던 그 자리: 승인해도 publication_command가 안
        생긴다(gate_service.py::_maybe_create_scheduled_publication_command가
        destination_channel=="hosted_site"면 그 자리에서 return한다) — 휴먼이
        여전히 화면에서 직접 «발행»/«재발행»을 눌러야 한다. 이 표면 수신자
        (에이전트)에게 "다음 워커 tick에 발행됩니다"(거짓)를 보내면 사람에게
        재발행이 필요하다는 것을 못 알릴 위험이 있다 — 옛 문구 그대로여야 한다.

        story #4155 유나 CHANGES(2026-09-10) — connection_id 대리값에서 실제
        PublicationCommand 존재 조회로 바뀐 뒤에도, hosted_site는 애초에 명령
        자체가 안 생기므로 이 테스트는 site_post_command_exists=False로 그대로
        같은 결론을 낸다(같은 조회 하나가 hosted_site·외부-생성실패 둘 다 잡는다).

        뮤테이션 대상: events.py의 `site_post_command_exists` 체크를 지우면(즉
        예전처럼 is_site_post만 보면) 이 테스트가 RED가 되어야 한다."""
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"),
            gate_row=gate_row, site_post_draft_exists=True, site_post_command_exists=False,
        )
        assert "- 다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다." in text
        assert "다음 워커 tick" not in text

    async def test_site_post_external_destination_scope_mismatch_keeps_human_screen_text(self):
        """story #4155 유나 CHANGES(2026-09-10) — 외부 목적지(connection_id 있음)
        인데도 `gate_service.py::_mark_scope_mismatch`(설계된 도달 상태 — 승인된
        목적지와 draft의 현재 목적지가 갈린 경우)나 `_mark_unresolved`(5경로) 중
        하나를 타면 publication_command가 안 만들어진다. 이전 처방(connection_id
        유무만 봄)은 이 경로를 "명령이 만들어졌다"로 잘못 읽어 거짓 문구를 냈다 —
        이제는 실제 명령 존재 여부로만 판단하므로(site_post_draft_exists=True인데
        site_post_command_exists=False) hosted_site와 같은 «할 일 없음» 문구가
        나와야 한다.

        뮤테이션 대상: 위 hosted_site 테스트와 같은 자리(site_post_command_exists
        체크)를 지우면 이 테스트도 함께 RED가 되어야 한다 — 외부 목적지인데 명령이
        없는 이 시나리오가 정확히 원래 결함이 재현되던 자리."""
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"),
            gate_row=gate_row, site_post_draft_exists=True, site_post_command_exists=False,
        )
        assert "- 다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다." in text
        assert "다음 워커 tick" not in text

    async def test_channel_post_approved_keeps_old_text_regression(self):
        """AC2 회귀 0 — channel_post(예약 상신)는 draft_id가 있어도(channel_posts.py도
        neutral_facts.draft_id를 stamp한다) site_post_drafts엔 없으므로 옛 문구 그대로."""
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"),
            gate_row=gate_row, site_post_draft_exists=False,
        )
        assert "- 다음 행동: 할 일 없음 — 발행은 휴먼이 화면에서 합니다." in text
        assert "다음 워커 tick" not in text

    async def test_gate_id_in_payload_fetches_exact_row_not_reconstructed(self):
        """story #3487 AC3(페드루 決定, story #3478 dual-destination 대비) — payload에
        gate_id가 있으면 db.get으로 그 행만 읽는다(재조회 쿼리를 아예 안 탄다). 뮤테이션
        대상: db.get 호출을 지우면 이 테스트가 db.execute만 호출되는 옛 경로로 빠져
        site_post_draft_exists=True를 반영 못 하고 RED가 된다."""
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id}, id_=uuid.uuid4())
        db = _fake_db(gate_row, site_post_draft_exists=True, site_post_command_exists=True)
        from app.routers.events import _render_gate_verdict_message

        text = await _render_gate_verdict_message(
            db, org_id=uuid.uuid4(),
            payload=_payload(gate_type="external_publish", verdict="approved", gate_id=str(gate_row.id)),
        )
        db.get.assert_awaited_once()
        assert "다음 워커 tick" in text
        assert f"- draft_id: {draft_id}" in text

    async def test_rejected_signal_is_keyword_based_not_a_blanket_reason_suppression(self):
        # "제목 오타 수정 필요"는 신호가 없어 문구가 뜬다(위 테스트) — "중단"이 들어간
        # 사유만 신호로 잡혀야 한다(과탐 방지, gate_reason_signal.py 자체 규율).
        text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="당분간 중단합니다",
        ))
        assert "다음 행동" not in text

    async def test_execution_verbs_are_absent_from_both_agent_branches(self):
        approved_text = await _render(_payload(gate_type="external_publish", verdict="approved"))
        rejected_text = await _render(_payload(
            gate_type="external_publish", verdict="rejected", resolution_note="사유 없이 반려",
        ))
        for verb in ("누르세요", "쓰세요", "발행하세요", "재상신하세요"):
            assert verb not in approved_text
            assert verb not in rejected_text

    async def test_draft_id_surfaces_as_plain_reference_not_a_link(self):
        draft_id = str(uuid.uuid4())
        gate_row = _FakeGateRow({"draft_id": draft_id})
        text = await _render(
            _payload(gate_type="external_publish", verdict="approved"), gate_row=gate_row,
        )
        assert f"- draft_id: {draft_id}" in text
        assert "http" not in text  # 참조이지 링크가 아니다.

    async def test_no_neutral_facts_omits_draft_id_line_without_erroring(self):
        text = await _render(_payload(gate_type="external_publish", verdict="approved"), gate_row=None)
        assert "draft_id" not in text


class TestOtherGateTypesUnchanged:
    """story #3387 회귀 0 — external_publish 이외 gate_type(예: qa/deploy/merge/pr_review·
    레시피 파이프라인)은 옛 문구를 그대로 유지한다."""

    async def test_non_external_publish_approved_keeps_old_publish_tool_text(self):
        text = await _render(_payload(gate_type="qa", verdict="approved"))
        assert "발행 도구" in text
        assert "할 일 없음" not in text

    async def test_non_external_publish_rejected_keeps_old_resubmit_text(self):
        text = await _render(_payload(gate_type="qa", verdict="rejected", resolution_note="폐기 대상"))
        assert "다시 발행하세요" in text
        assert "자동 재오픈됩니다" in text
