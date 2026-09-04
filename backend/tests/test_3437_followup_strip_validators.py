"""story #3437(후속 묶음, 페드루 PO 確定 2026-09-05) — title/slug/summary/text/name
공백-only 값이 min_length=1을 통과·저장되던 결함(Pydantic min_length은 strip 안 함).
conversations.py:1259-1265 정본 패턴 미러(field_validator + strip + 빈 문자열 ValueError).

pure 유닛 — Pydantic 모델 인스턴스화만으로 검증(DB 무연결, 실 DB 필요한 라우터/서비스
계층 회귀 테스트는 backend-test-destructive 쪽 realDB 스위트에 별도)."""
from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from app.routers.campaigns import CreateCampaignRequest
from app.routers.channel_posts import CreateChannelPostDraftVersionRequest
from app.routers.site_posts import CreateSitePostDraftVersionRequest, PublishSitePostRequest


class TestSitePostsStrip:
    @pytest.mark.parametrize("field", ["title", "slug", "summary"])
    def test_create_draft_version_whitespace_only_rejected(self, field: str) -> None:
        kwargs = {
            "work_item_id": uuid.uuid4(), "title": "제목", "slug": "slug", "lang": "ko",
            "summary": "요약", "body_md": "본문",
        }
        kwargs[field] = "   "
        with pytest.raises(ValidationError, match="must not be empty"):
            CreateSitePostDraftVersionRequest(**kwargs)

    def test_create_draft_version_trims_surrounding_whitespace(self) -> None:
        req = CreateSitePostDraftVersionRequest(
            work_item_id=uuid.uuid4(), title="  제목  ", slug="slug", lang="ko",
            summary="요약", body_md="본문",
        )
        assert req.title == "제목"

    @pytest.mark.parametrize("field", ["title", "slug", "summary"])
    def test_publish_whitespace_only_rejected(self, field: str) -> None:
        kwargs = {
            "work_item_id": uuid.uuid4(), "title": "제목", "slug": "slug", "lang": "ko",
            "summary": "요약", "body_md": "본문",
        }
        kwargs[field] = "   "
        with pytest.raises(ValidationError, match="must not be empty"):
            PublishSitePostRequest(**kwargs)


class TestChannelPostsStrip:
    def test_text_whitespace_only_rejected(self) -> None:
        with pytest.raises(ValidationError, match="must not be empty"):
            CreateChannelPostDraftVersionRequest(
                work_item_id=uuid.uuid4(), connection_id=uuid.uuid4(), text="   ",
            )

    def test_text_trims_surrounding_whitespace(self) -> None:
        req = CreateChannelPostDraftVersionRequest(
            work_item_id=uuid.uuid4(), connection_id=uuid.uuid4(), text="  본문  ",
        )
        assert req.text == "본문"


class TestCampaignsStrip:
    def test_name_whitespace_only_rejected(self) -> None:
        with pytest.raises(ValidationError, match="must not be empty"):
            CreateCampaignRequest(name="   ")

    def test_name_trims_surrounding_whitespace(self) -> None:
        req = CreateCampaignRequest(name="  캠페인  ")
        assert req.name == "캠페인"
