"""H1-S3: gate evidence metadata 컬럼/스키마 노출 테스트(0118).

실 마이그 up/down·backfill은 CI alembic-fresh-db + 로컬 실 PG로 검증. 여기선 모델/스키마 계약(AC③)을
DB 없이 잠근다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.models.gate import Gate
from app.routers.gates import GateResponse

_NEW_FIELDS = ("requires_human", "evidence_status", "decision_basis", "auto_decision_reason")


def test_gate_model_has_evidence_columns():
    cols = set(Gate.__table__.c.keys())
    for f in _NEW_FIELDS:
        assert f in cols, f
    # requires_human은 NOT NULL + server_default false.
    rh = Gate.__table__.c.requires_human
    assert rh.nullable is False and rh.server_default is not None


def test_gate_response_exposes_new_fields_with_defaults():
    # 새 필드 미지정 객체도 검증 통과(하위호환 default) — AC③.
    base = dict(
        id=uuid.uuid4(), org_id=uuid.uuid4(), work_item_id=uuid.uuid4(),
        work_item_type="story", gate_type="merge", status="pending",
        resolver_id=None, resolved_at=None, resolution_note=None, neutral_facts=None,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    obj = type("G", (), base)()
    r = GateResponse.model_validate(obj)
    assert r.requires_human is False  # default.
    assert r.evidence_status is None and r.decision_basis is None and r.auto_decision_reason is None

    # 값이 있으면 그대로 노출.
    obj2 = type("G", (), {**base, "requires_human": True, "evidence_status": "self_report_only",
                          "decision_basis": "policy+evidence", "auto_decision_reason": "ask_human"})()
    r2 = GateResponse.model_validate(obj2)
    assert r2.requires_human is True and r2.evidence_status == "self_report_only"
    assert r2.decision_basis == "policy+evidence" and r2.auto_decision_reason == "ask_human"
