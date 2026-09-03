"""story #3370(Phase0·마케팅운영 S5, 페드루 PO 지시 2026-09-03) — preset.gate.verdict
payload_schema에 gate_draft_author_member_id(선택) 필드를 연다.

[[no-pr-for-data]] 게이트 — 프리셋 표현/스키마 변경(0251/0301/0303 선례와 동일 규칙, 병합
전 선생님 확認 필요할 수 있음).

배경: 게이트 판정 통지 수신자 집합(work_item_stakeholders)이 work item assignee·
requester(0303, story #3340)는 포함하지만 "이 초안을 쓴 사람"(글 원작성자, 대개 담롱류
고객 에이전트)은 명시적으로 빠져 있었다. gate_service.py::_publish_gate_verdict_
notification이 게이트를 만든 recipe_gate_hooks.py::_build_approval_neutral_facts가
채운 neutral_facts.draft_author_member_id를 이 새 payload 키로 실어 보내면,
event_routing_resolver.py::_resolve_work_item_stakeholders가 그 값을 이해관계자 집합에
합류시킨다(gate_requester_member_id와 동형 3단 파이프).

payload_schema는 `additionalProperties: false`라 이 필드가 스키마에 없으면 발행 자체가
422로 거부된다 — 0303(gate_requester_member_id 추가) 선례와 동일한 additive-only 변경.

Revision ID: 0308
Revises: 0307
Create Date: 2026-09-03

⚠️번호 충돌 주의 — PR#3731(story #3365, S1 site_posts 초안)이 병합 시점에 이 번호(0308)를
먼저 클레임했다면 그쪽이 develop에 먼저 서고 이 파일은 rebase 시 0309로 밀려야 한다(이
파일이 site_posts와 무관한 별개 도메인 변경이라 순서 자체는 무의미 — 번호만 재부여).
"""
from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0308"
down_revision = "0307"
branch_labels = None
depends_on = None

_KEY = "preset.gate.verdict"

# 0303 이후 현행 그대로(무손실 보존, 0301/0303과 동일 스타일 — 전체 리터럴 교체로 드리프트
# 방지).
_OLD_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_title": {"type": ["string", "null"]},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
    },
}

_NEW_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_title": {"type": ["string", "null"]},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
        # story #3370 — 선택 필드(required엔 안 넣는다, 0303의 gate_requester_member_id와
        # 동일 원칙).
        "gate_draft_author_member_id": {"type": "string", "format": "uuid"},
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, version = version + 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"payload_schema": json.dumps(_NEW_PAYLOAD_SCHEMA), "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET payload_schema = :payload_schema, version = version - 1 "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"payload_schema": json.dumps(_OLD_PAYLOAD_SCHEMA), "key": _KEY},
    )
