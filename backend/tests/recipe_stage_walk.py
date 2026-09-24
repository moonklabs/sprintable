"""story #4251 — 레시피 stage를 **순서대로 · 바인딩된 멤버로** 낼 수 있게 앞 상태를 실제로 까는 테스트 공용 헬퍼.

4251부터 원시 발행(`publish_registry_event` · MCP `publish_event`)은 stage 순서 · 담당을 검증한다
(`recipe_stage_completion.validate_raw_stage_publish`). 발행 뒤의 동작(게이트 · 라우팅 · 워커 · 알림)을 보는 테스트는 중간 stage를
곧바로 내곤 했다 — 그 테스트들이 검증을 우회하지 않고(우회 플래그 없음 · PO 4251 D) 실제 상태에서 출발하도록, 여기서 **앞 stage의
발행 이력 · 게이트 승인 · 바인딩**을 실제 행으로 깐다. 검증기 자체를 보는 테스트는 이 헬퍼를 쓰지 않는다(test_4251 · test_4249).

- `prepare_stage_publish(...)`: `stage`를 `publisher`가 지금 낼 수 있는 상태를 만든다.
  - 첫 stage: `publisher`가 사람이 아니면 첫 stage에 바인딩한다(이미 바인딩된 멤버가 다르면 멈춘다 — 테스트가 고를 일).
  - 그 밖: 앞 stage 발행 이력 1건(발신 = `publisher`)을 남긴다.
    - 앞 stage에 레시피 게이트가 있으면 승인된 게이트 행(요청자 = `publisher`)을 둔다 — 승인 뒤 «요청자가 다음 stage를 낸다».
    - 앞 stage가 서버 · 연산 커넥터 stage면 `publisher`를 이 stage에 바인딩한다(«다음 stage 담당이 잇는다»).
    - 그 밖엔 `publisher`를 앞 stage에 바인딩한다(«그 stage 담당이 다음 stage를 낸다»).
  - 앞 stage가 서버에 넘기는 자리(발송 게이트 등)거나 `stage` 자체가 서버 stage면 멤버는 못 낸다 — `publish_as_server`를 쓴다.
- `publish_as_server(...)`: 서버가 실제 일을 한 뒤 내는 stage(채널 게시 · 발송 뒤 확인)를 시스템 발행자로 낸다 — 운영 코드의
  서버 발행 입구와 같은 인자(`stage_origin="server"`).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select


def _enum(definition) -> list[str]:
    return list(((definition.payload_schema or {}).get("properties") or {}).get("stage", {}).get("enum") or [])


async def _bind(s, *, org_id, project_id, definition_key: str, stage: str, member_id) -> None:
    from app.models.recipe_role_binding import RecipeRoleBinding

    existing = (await s.execute(
        select(RecipeRoleBinding).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.event_definition_key == definition_key,
            RecipeRoleBinding.stage == stage,
            RecipeRoleBinding.project_id == project_id if project_id is not None else RecipeRoleBinding.project_id.is_(None),
        )
    )).scalar_one_or_none()
    if existing is None:
        s.add(RecipeRoleBinding(
            id=uuid.uuid4(), org_id=org_id, project_id=project_id, event_definition_key=definition_key,
            stage=stage, agent_member_id=member_id,
        ))
    elif existing.agent_member_id != member_id:
        raise AssertionError(
            f"{definition_key}:{stage}는 이미 다른 멤버({existing.agent_member_id})에 바인딩돼 있다 — 그 멤버로 내거나 테스트가 "
            f"바인딩을 고른다({member_id})",
        )


async def seed_stage_publish(
    s, *, org_id, project_id, definition, work_item_type: str, work_item_id, stage: str, sender_id,
) -> uuid.UUID:
    """`stage`의 발행 이력 1건(지금 stage 판정이 읽는 행 그대로 — 대화 · 메시지 · event 메타). 메시지 id를 돌려준다."""
    from app.models.conversation import Conversation, ConversationMessage

    conversation = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group", status="open")
    s.add(conversation)
    await s.flush()
    message = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation.id, sender_id=sender_id, content=f"[seed] {definition.key} {stage}",
        msg_metadata={"event": {
            "event_key": definition.key,
            "payload": {"stage": stage, "work_item_type": work_item_type, "work_item_id": str(work_item_id)},
            "refs": {"seeded_by": "tests.recipe_stage_walk"},
        }},
    )
    s.add(message)
    return message.id


async def seed_approved_stage_gate(
    s, *, org_id, definition, work_item_type: str, work_item_id, stage: str, requester_id, approver_id=None,
):
    """`stage`의 레시피 게이트를 승인된 상태로 둔다(요청자 = 그 stage를 낸 멤버 · 게이트 생성 훅이 싣는 사실 그대로)."""
    from app.models.gate import Gate

    gate_decl = ((definition.stage_metadata or {}).get(stage) or {}).get("gate") or {}
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        gate_type=gate_decl["type"], status="approved", resolver_id=approver_id,
        neutral_facts={"triggered_by_event": definition.key, "stage": stage, "requested_by_member_id": str(requester_id)},
    )
    s.add(gate)
    return gate


async def prepare_stage_publish(
    Session, *, org_id, project_id, definition, work_item_id, stage: str, publisher_id, work_item_type: str = "story",
    publisher_is_human: bool = False,
) -> None:
    """`publisher`가 `stage`를 지금 낼 수 있게 앞 상태를 깐다(모듈 docstring)."""
    enum = _enum(definition)
    assert stage in enum, (definition.key, stage, enum)
    idx = enum.index(stage)
    async with Session() as s:
        if idx == 0:
            if not publisher_is_human:
                await _bind(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage, member_id=publisher_id)
        else:
            prev = enum[idx - 1]
            await seed_stage_publish(
                s, org_id=org_id, project_id=project_id, definition=definition, work_item_type=work_item_type,
                work_item_id=work_item_id, stage=prev, sender_id=publisher_id,
            )
            prev_meta = (definition.stage_metadata or {}).get(prev) or {}
            if (prev_meta.get("capability") or {}).get("target") in ("channel_connection", "generation_connector"):
                # 서버 · 연산 커넥터 stage 뒤는 «다음 stage 담당»(4242 수신자 규칙)이 잇는다 — 앞 stage가 아니라 이 stage에 묶는다.
                await _bind(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage, member_id=publisher_id)
            elif prev_meta.get("gate"):
                await seed_approved_stage_gate(
                    s, org_id=org_id, definition=definition, work_item_type=work_item_type, work_item_id=work_item_id,
                    stage=prev, requester_id=publisher_id,
                )
            else:
                await _bind(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=prev, member_id=publisher_id)
        await s.commit()


async def publish_as_server(db, *, org_id, definition_key: str, payload: dict):
    """서버가 내는 stage를 시스템 발행자로 낸다(운영의 `emit_recipe_published_stage_event`와 같은 `stage_origin="server"`)."""
    from fastapi import BackgroundTasks

    from app.dependencies.auth import AuthContext
    from app.routers.events import _get_or_create_system_publisher, _publish_registry_event_core

    system_member = await _get_or_create_system_publisher(db, org_id)
    auth = AuthContext(
        user_id=str(system_member.id), email=None,
        claims={"app_metadata": {"api_key_id": "system-publisher"}}, org_id=str(org_id),
    )
    return await _publish_registry_event_core(
        db, org_id, auth, definition_key, payload, BackgroundTasks(), stage_origin="server",
    )
