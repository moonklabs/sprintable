"""story #2724(2026-08-17, 페드루 PO 판정) — VisualArtifactSummary/Detail의 `unlinked` 응답
필드 단위(DB 무접촉). additive-only 신규 필드 — story_id·doc_id가 둘 다 없다는 **사실만**
싣는다(epic_id는 이 판정에 안 들어감, PO 문구 "story/doc 미연결" 그대로).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

_NOW = datetime.now(timezone.utc)


def _summary_kwargs(**overrides):
    base = dict(
        id=uuid.uuid4(), title="T", story_id=None, epic_id=None, doc_id=None,
        source="created", latest_version_number=1, anchor_version=None,
        created_by=None, created_at=_NOW, canvas_bounds=None, unresolved_comment_count=0,
    )
    base.update(overrides)
    return base


def test_summary_unlinked_true_when_no_story_or_doc():
    from app.schemas.visual_artifact import VisualArtifactSummary
    s = VisualArtifactSummary(**_summary_kwargs())
    assert s.unlinked is True


def test_summary_unlinked_false_when_story_linked():
    from app.schemas.visual_artifact import VisualArtifactSummary
    s = VisualArtifactSummary(**_summary_kwargs(story_id=uuid.uuid4()))
    assert s.unlinked is False


def test_summary_unlinked_false_when_doc_linked():
    from app.schemas.visual_artifact import VisualArtifactSummary
    s = VisualArtifactSummary(**_summary_kwargs(doc_id=uuid.uuid4()))
    assert s.unlinked is False


def test_summary_unlinked_ignores_epic_id():
    """⭐epic_id만 있고 story_id·doc_id 둘 다 없으면 여전히 unlinked=True — PO 문구
    "story/doc 미연결"이 epic을 안 본다는 것을 정확히 반영(판정 근거를 넓히지 않는다)."""
    from app.schemas.visual_artifact import VisualArtifactSummary
    s = VisualArtifactSummary(**_summary_kwargs(epic_id=uuid.uuid4()))
    assert s.unlinked is True


def test_detail_unlinked_matches_summary_semantics():
    from app.schemas.visual_artifact import ArtifactNodeOut, VisualArtifactDetail
    d = VisualArtifactDetail(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), title="T",
        story_id=None, epic_id=None, doc_id=None, source="created",
        latest_version_number=1, anchor_version=None, created_by=None,
        created_at=_NOW, updated_at=_NOW, version_number=1, version_summary=None,
        version_source_comment_id=None, canvas_bounds=None, nodes=[],
        unresolved_comment_count=0, org_slug=None, project_slug=None,
    )
    assert d.unlinked is True
    d2 = d.model_copy(update={"story_id": uuid.uuid4()})
    assert d2.unlinked is False


def test_summary_model_dump_includes_unlinked_key():
    """⭐model_dump()(라우터가 실제로 JSON 응답에 쓰는 경로)가 이 필드를 빠뜨리지 않는지
    직접 확認 — computed_field는 선언만으론 직렬화 누락 가능성이 있는 클래스라(Pydantic
    구현 세부) 실제 dump 결과로 pin한다."""
    from app.schemas.visual_artifact import VisualArtifactSummary
    s = VisualArtifactSummary(**_summary_kwargs())
    dumped = s.model_dump(mode="json")
    assert dumped["unlinked"] is True
