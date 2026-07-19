"""Small, fail-closed unit contract tests for the Advisor P0 boundary."""
from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from app.routers.evidence import EvidenceCreateRequest
from app.routers.gates import GateCreateRequest
from app.routers.workflow_report import ReportDoneRequest
from app.services.advisor_context import MAX_CLAIM_BYTES, canonical_claim


def _report_body(**overrides):
    body = {
        "story_id": uuid.uuid4(),
        "stage": "merge",
        "agent_id": uuid.uuid4(),
    }
    body.update(overrides)
    return body


def _review(**overrides):
    value = {
        "schema_version": 1,
        "mode": "local",
        "verdict": "likely_pass",
        "advisor_model": "local-reviewer",
        "findings": [],
        "keep": [],
    }
    value.update(overrides)
    return value


def test_canonical_claim_accepts_exactly_32kib_utf8_bytes():
    # JSON adds a fixed seven-byte wrapper around the value: {"x":"..."}.
    payload = {"x": "가" * ((MAX_CLAIM_BYTES - len('{"x":""}'.encode())) // 3)}
    canonical, _ = canonical_claim(payload)
    assert len(canonical.encode("utf-8")) <= MAX_CLAIM_BYTES


def test_canonical_claim_rejects_over_32kib_utf8_bytes_before_side_effects():
    payload = {"x": "가" * ((MAX_CLAIM_BYTES // 3) + 100)}
    with pytest.raises(Exception) as exc:
        canonical_claim(payload)
    assert getattr(exc.value, "status_code", None) == 422


def test_report_done_rejects_malformed_review_schema_before_endpoint_execution():
    with pytest.raises(ValidationError):
        ReportDoneRequest(**_report_body(self_review=_review(schema_version=2)))


@pytest.mark.parametrize("review", [
    _review(advisor_model="m" * 201),
    _review(findings=[{"code": "C", "severity": "critical", "message": "bad", "evidence_refs": []}]),
    _review(findings=[{"code": "C" * 1001, "severity": "high", "message": "bad", "evidence_refs": []}]),
    _review(findings=[{"code": "C", "severity": "high", "message": "m" * 1001, "evidence_refs": []}]),
    _review(findings=[{"code": "C", "severity": "high", "message": "ok", "evidence_refs": ["r"] * 21}]),
    _review(keep=["k"] * 11),
])
def test_report_done_rejects_out_of_contract_review_fields_before_endpoint_execution(review):
    """Every nested claim bound is part of the pre-side-effect Pydantic rail."""
    with pytest.raises(ValidationError):
        ReportDoneRequest(**_report_body(self_review=review))


@pytest.mark.parametrize("source", ["advisor.executor_claim.v1", "advisor.any_future_namespace"])
def test_public_evidence_create_rejects_entire_reserved_advisor_namespace(source):
    with pytest.raises(ValidationError):
        EvidenceCreateRequest(
            work_item_id=uuid.uuid4(), work_item_type="story", type="report", ref="test", source=source,
        )


@pytest.mark.parametrize("key", ["advisor_origin", "advisor_policy", "executor_advisor_claim"])
def test_public_gate_create_rejects_reserved_advisor_pointer_keys(key):
    with pytest.raises(ValidationError):
        GateCreateRequest(
            work_item_id=uuid.uuid4(), work_item_type="story", gate_type="human_review",
            member_id=uuid.uuid4(), role_id=uuid.uuid4(), neutral_facts={key: {"x": 1}},
        )


def test_advisor_envelope_is_stable_and_contains_only_optional_claim_fields():
    request = ReportDoneRequest(**_report_body(summary="done", self_review=_review()))
    envelope = request.advisor_envelope()
    assert envelope == {
        "summary": "done", "head_sha": None, "intent_hash": None, "self_review": _review(),
    }
    assert json.loads(canonical_claim(envelope)[0]) == envelope


@pytest.mark.parametrize("review", [
    {**_review(), "unexpected": True},
    {**_review(), "findings": [{"code": "C", "severity": "low", "message": "m", "evidence_refs": [], "unexpected": True}]},
])
def test_self_review_rejects_unknown_keys_at_every_nested_level(review):
    with pytest.raises(ValidationError):
        ReportDoneRequest(**_report_body(self_review=review))


def test_advisor_rollout_config_fails_closed_when_enabled():
    from app.core.config import Settings

    disabled = Settings(_env_file=None, advisor_p0_enabled=False)
    disabled.validate_advisor_p0_rollout()
    with pytest.raises(ValueError):
        Settings(_env_file=None, advisor_p0_enabled=True).validate_advisor_p0_rollout()
    with pytest.raises(ValueError):
        Settings(_env_file=None, advisor_p0_enabled=True, advisor_p0_org_allowlist="a",
                 advisor_p0_provenance_approved_orgs="b").validate_advisor_p0_rollout()
    Settings(_env_file=None, advisor_p0_enabled=True, advisor_p0_org_allowlist="a",
             advisor_p0_provenance_approved_orgs="a,b").validate_advisor_p0_rollout()


@pytest.mark.anyio
@pytest.mark.parametrize("origin", ["not-an-object", {"schema_version": 2}])
async def test_transition_rejects_present_but_malformed_advisor_origin(origin):
    from app.services.gate_service import transition_gate

    gate = MagicMock()
    gate.neutral_facts = {"advisor_origin": origin}
    result = MagicMock()
    result.scalar_one_or_none.return_value = gate
    session = AsyncMock()
    session.execute.return_value = result

    with pytest.raises(ValueError, match="Advisor-origin integrity error"):
        await transition_gate(session, uuid.uuid4(), uuid.uuid4(), "approved", resolver_id=uuid.uuid4())
