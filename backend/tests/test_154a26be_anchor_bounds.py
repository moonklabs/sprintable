"""story #154a26be — 아티팩트 좌표 코멘트 anchor_x/y 상한(%, 0~100) 검증.

디디 그라운딩(PR 3186) 발견: `CreateArtifactCommentRequest`는 상한은커녕 하한도 서버가
안 막고 있었다(하한 체크는 `CreateSpecPinRequest`에만 있었음 — 스토리 본문의 "하한만
검증" 서술은 두 클래스를 혼동한 것으로 보이나, 실제 갭은 코멘트 쪽이 더 컸다).

⛔`CreateSpecPinRequest`는 **다른 단위 계약**(px, canvas_bounds 좌표계)이라 %(0~100)
상한을 안 건다 — 처음엔 두 클래스가 같은 % 컨벤션이라 오판해 여기도 le=100을 걸었으나,
미르코 QA 음성대조(정상 데이터 638.4가 422로 깨짐)가 잡아 상한을 롤백했다(페드루 PO,
2026-08-17). 하한(>=0)만 유지 — 이 파일의 SpecPin 축은 그 롤백 후 계약을 고정한다.

Pydantic ValidationError → FastAPI가 422로 변환하는 게 기본 동작이라, 여기서는 스키마
계층에서 직접 ValidationError 발생 여부를 검증한다(라우터까지 왕복하지 않아도 "422 발생
경로"의 근본 원인을 pin — router는 이 스키마를 body로 그대로 받으므로 무회귀)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError


class TestCreateArtifactCommentRequestBounds:
    def test_anchor_x_over_100_rejected(self):
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        with pytest.raises(ValidationError):
            CreateArtifactCommentRequest(content="c", anchor_x=100.1, anchor_y=50)

    def test_anchor_y_over_100_rejected(self):
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        with pytest.raises(ValidationError):
            CreateArtifactCommentRequest(content="c", anchor_x=50, anchor_y=100.1)

    def test_pixel_scale_value_rejected(self):
        """실측 근거(#154a26be) — artifact_spec_pins에서 실제로 발견된 오염 값(638.4)과
        같은 스케일의 입력이 확실히 거부되는지."""
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        with pytest.raises(ValidationError):
            CreateArtifactCommentRequest(content="c", anchor_x=638.4, anchor_y=398.4)

    def test_anchor_negative_rejected(self):
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        with pytest.raises(ValidationError):
            CreateArtifactCommentRequest(content="c", anchor_x=-0.1, anchor_y=50)

    def test_anchor_boundary_0_and_100_accepted(self):
        """경계값 자체(0·100)는 유효 — 배타적(exclusive) 아님."""
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        req = CreateArtifactCommentRequest(content="c", anchor_x=0, anchor_y=100)
        assert req.anchor_x == 0
        assert req.anchor_y == 100

    def test_anchor_within_range_accepted(self):
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        req = CreateArtifactCommentRequest(content="c", anchor_x=50.5, anchor_y=12.3)
        assert req.anchor_x == 50.5

    def test_node_anchor_without_coords_still_valid(self):
        """node_id 앵커(anchor_x/y 둘 다 None)는 이 상한 검증과 무관 — 무회귀."""
        import uuid

        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        req = CreateArtifactCommentRequest(content="c", node_id=uuid.uuid4())
        assert req.anchor_x is None
        assert req.anchor_y is None


class TestCreateSpecPinRequestBounds:
    def test_pixel_scale_value_accepted(self):
        """⛔story #154a26be 정정(페드루 PO, 2026-08-17) — 이 클래스는 px(canvas_bounds
        좌표계)라 %(0~100) 상한이 없다. dev DB 실측값(638.4, 398.4)은 오염이 아니라
        정상 데이터였음(FE `edit-canvas.tsx`가 unitless left/top=px로 직접 씀) — 음성대조:
        이 값이 «여전히 통과해야» 한다. 처음엔 이걸 «오염값→거부해야 함»으로 잘못 판단해
        le=100을 걸 뻔했고(미르코 QA가 라이브 배치 과잉살상 위험으로 잡음), 지금은 정확히
        반대 방향(수용)을 고정한다."""
        from app.schemas.visual_artifact import CreateSpecPinRequest

        req = CreateSpecPinRequest(anchor_type="coord", anchor_x=638.4, anchor_y=398.4, description="d")
        assert req.anchor_x == 638.4
        assert req.anchor_y == 398.4

    def test_anchor_within_range_accepted(self):
        from app.schemas.visual_artifact import CreateSpecPinRequest

        req = CreateSpecPinRequest(anchor_type="coord", anchor_x=50, anchor_y=50, description="d")
        assert req.anchor_x == 50

    def test_negative_anchor_still_rejected(self):
        """하한(>=0)은 이 fix 前부터 있던 기존 검증 — 상한만 롤백됐지 하한은 그대로."""
        from app.schemas.visual_artifact import CreateSpecPinRequest

        with pytest.raises(ValidationError):
            CreateSpecPinRequest(anchor_type="coord", anchor_x=-1, anchor_y=50, description="d")

    def test_node_anchor_unaffected(self):
        """anchor_type='node'는 anchor_x/y 자체를 안 받는 기존 규칙 그대로 무회귀."""
        import uuid

        from app.schemas.visual_artifact import CreateSpecPinRequest

        req = CreateSpecPinRequest(anchor_type="node", node_id=uuid.uuid4(), description="d")
        assert req.anchor_x is None


class TestFieldDescriptionPromoted:
    """AC③ — 도크스트링 규약을 스키마 필드 description으로 승격(계약 표면에 명시)."""

    def test_comment_anchor_fields_have_percent_description(self):
        from app.schemas.visual_artifact import CreateArtifactCommentRequest

        schema = CreateArtifactCommentRequest.model_json_schema()
        assert "%" in schema["properties"]["anchor_x"]["description"]
        assert "%" in schema["properties"]["anchor_y"]["description"]
