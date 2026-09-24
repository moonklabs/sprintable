"""story #4050(E-RECIPE-1 ①) — backend spine 3장(#4419 seed·#4423 gates·#4425 evidence
defense) 위에서 AC5("PO 스크립트 0회·사람 개입 ≤4·apply→9stage→게이트4→예산→발행")를 실제
9-stage 관통으로 검증하고, 유나 gap ③(연산=모델 config·발행자=발행 채널 슬롯)이 이 최소
경로 완주에 explicit 바인딩을 필요로 하는지 판정한다.

AC2/AC3 결론(코드 근거, 이 파일의 단위축이 고정) — **둘 다 불요, defaults로 충분**:
  · `stage_metadata[stage].capability`의 실제 소비자는 코드베이스 전체에 정확히 2곳뿐
    (`grep` 실측): ①`event_definition_registry.py::validate_stage_metadata`(등록 시점
    shape 검증) ②`events.py::apply_recipe_role_bindings`(apply 시점 커넥터 warning,
    "막지 않음"이 PO 확定). 그 밖엔 아무도 안 읽는다 — "연산"(live_generation)·"발행자"
    (published)의 실제 모델/채널 선택은 순수 BYOA 에이전트 자신의 외부 설정이고, Sprintable
    backend는 그 축을 아예 모른다(원 도크 §2 "BYOA 갈아끼우기 지점"의 문자 그대로 — 모델
    임대·발행 라인은 에이전트가 "가져오는" 것, 플랫폼이 배선하는 것이 아니다).
  · `external_publish` 게이트 approved 전이가 부르는 `_maybe_create_scheduled_publication_
    command`(gate_service.py)는 실측하면 우리 게이트에서 **가장 조용한 경로**로 빠진다 —
    `comment_reply` 분기 아님 → `destination_channel=(neutral_facts.get("destination"))`이
    None(우리 훅은 "channel" 키만 채운다, "destination" 아님)이라 `is_blog_gate=False` →
    channel_post(social) 분기로 떨어지는데 `gate.sealed_scheduled_at`이 아예 없어(그 필드는
    channel_posts.py 전용이라 우리 훅이 세팅하지 않음) **경고 로그도 없이 즉시 return**한다.
    즉 `PublicationCommand`는 0건 생성된다(아래 실측 pin) — 이건 결함이 아니라 설계상
    정확한 경계: "발행 승인"까지가 플랫폼 몫, "그 승인을 보고 실제 채널에 포스팅하는" 실행은
    발행자 에이전트(BYOA)가 게이트 approved 신호를 관찰해 스스로 수행한다.

결론 — apply 계약 확장(디디 #4048 disabled picker 활성화) 불요. «있음/만들 것» 경계:
**있음** = 9-stage 오케스트레이션 + 게이트4 자동생성/승인 + 예산 하드체크 + capability
존재선언(warning 전용). **만들 것 아님** = 모델/채널 실행 바인딩(그 자체가 BYOA 원칙과
충돌 — 플랫폼이 대신 정하면 "갈아끼우기"가 아니게 된다).
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4050")
_MIG_0382 = _load_migration_module("0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4050")

# 0381+0382 누적 결과(=develop 착지 후의 실제 최종 shape, 17:12 배치 renumber 반영 —
# 최초 번호는 0379/0380이었다) — 0382._NEW_*가 이미 0381 위에 얹은 최종값이다(migration
# 자체의 dict.update 관례, 0382 소스 참조).
_KEY = _MIG_0382._KEY
_STAGE_METADATA = _MIG_0382._NEW_STAGE_METADATA
_PAYLOAD_SCHEMA = _MIG_0382._NEW_PAYLOAD_SCHEMA
_ROUTING = _MIG_0381._ROUTING

_GATE_ORDER = [
    ("concept_confirmed", "concept_approval"),
    ("animatic", "structure_approval"),
    ("structure_passed", "generation_budget"),
    ("pending_approval", "external_publish"),
]
_NO_GATE_STAGES = ["draft", "live_generation", "verification", "editing", "published"]


# ─── 단위 축 — capability 소비자가 정확히 2곳뿐인지 고정(코드 위치 자체가 증거) ──────


def test_capability_field_has_exactly_five_consumers_in_codebase():
    """AC2/AC3 근거 — stage_metadata.capability를 읽는 코드가 등록시점 검증 1곳 +
    apply시점 warning 1곳뿐임을 고정한다. 새 소비자가 추가되면 이 테스트가 그 사실을
    알려준다(연산/발행자 슬롯에 실제 배선이 생겼다는 뜻이므로 이 카드의 결론을 재검토
    해야 한다).

    ⛔story #4090(alembic 0387, 페드루 PO 確定 2026-09-21) — 바로 그 재검토가 일어난
    자리. 발행자(Publisher) 슬롯에 실제 배선(capability.target으로 채널-바인딩 stage
    판별, apply_recipe_role_bindings::_is_channel_stage)이 생겨 events.py의 소비처가
    1→2로 늘었다 — 이 테스트가 설계대로 그 사실을 잡았다(RED 확認 후 의도적 갱신,
    삭제/완화 아님). registry_module 쪽도 _CAPABILITY_TARGETS 검증(target 필드
    닫힌-어휘 체크)이 새 "capability" 리터럴을 더했지만, 그 축은 애초에 정확한 개수가
    아니라 ">0"만 고정하므로 별도 갱신 불요.

    ⛔재갱신(AC3, 같은 확定일) — `_render_gate_verdict_message`가 다음 stage의
    capability.target을 읽어 자동발행 안내문 갈래를 고르는 세 번째 소비처가 추가돼
    2→3으로 또 늘었다(같은 원리, 같은 절제 — RED 확認 후 의도적 갱신).

    ⛔재갱신(story #4088 2/2, PO CI 리뷰 2026-09-21) — `_render_event_message_content`
    가 현재 stage의 capability.kind로 자기설명 멘션 힌트(attach_video/generate)를
    고르는 네 번째 소비처가 추가돼 3→4로 또 늘었다.

    ⛔재갱신(story #4110, 2026-09-21) — 신규 `get_my_generation_connector`(바인딩 crew
    에이전트가 자기 레시피의 generation_connector-target stage 판정에 capability.target을
    읽는 REST)가 다섯 번째 소비처로 추가돼 4→5로 또 늘었다. 함수 이름의 "four"도 이미
    실값과 어긋난 지 오래라 이 갱신에서 같이 고친다(참조하는 곳이 이 파일 하나뿐임을
    확認 후 rename)."""
    import ast
    import inspect

    import app.routers.events as events_module
    import app.services.event_definition_registry as registry_module

    def _capability_consumers(module) -> list[str]:
        """각 "capability" 리터럴을 감싸는 가장 안쪽 함수 이름(정렬). 중첩 함수 안의 리터럴은 바깥 함수에 중복 계산 안 함."""
        tree = ast.parse(inspect.getsource(module))
        names: list[str] = []

        def visit(node, owner):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    visit(child, child.name)
                else:
                    if isinstance(child, ast.Constant) and child.value == "capability" and owner is not None:
                        names.append(owner)
                    visit(child, owner)

        visit(tree, None)
        return sorted(names)

    def _count_capability_subscripts(module) -> int:
        tree = ast.parse(inspect.getsource(module))
        count = 0
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and node.value == "capability":
                count += 1
        return count

    # events.py: capability 소비처를 **이름으로** 고정한다(story #4174 — 예전 숫자 단언 «== 5»는 늘었을 때 어느 자리가
    # 늘었는지 말해 주지 못했다). 각 "capability" 리터럴을 감싸는 가장 안쪽 함수 이름의 목록:
    # 기존 warning 축(§3317 PR B, `apply_recipe_role_bindings`·그 안의 `_stage_target`)·story #4090 AC3
    # `_render_gate_verdict_message`(다음 stage capability.target으로 자동발행 안내)·story #4110
    # `_resolve_crew_scoped_recipe_binding`·story #4174 `_stage_capability_kind`(capability.kind 읽기 공용 — 멘션 도구
    # 안내·서버 몫 다음 단계·블로그 레시피 문맥 판별이 같이 쓴다. 새 kind 소비처는 이 함수를 거친다).
    # story #4239(RED 확인 뒤 의도적 갱신) — `apply_recipe_role_bindings`가 `capability.channels`(허용 채널 종류)를 읽어
    # 허용 밖 연결 바인딩을 422로 거절하는 두 번째 읽기가 생겼다(같은 함수 안 · 새 함수 아님).
    assert _capability_consumers(events_module) == [
        "_render_gate_verdict_message", "_resolve_crew_scoped_recipe_binding", "_stage_capability_kind",
        "_stage_target", "apply_recipe_role_bindings", "apply_recipe_role_bindings",
    ]
    # event_definition_registry.py: validate_stage_metadata 안의 `meta["capability"]`류 —
    # shape 검증 로직 안에서 "capability" 리터럴이 여러 번 등장(object 검사·에러 메시지 등)
    # 하므로 정확한 개수보다 "0이 아님(소비자가 실존)"만 고정한다.
    assert _count_capability_subscripts(registry_module) > 0


# ─── 실행 축(realdb) — 9-stage 전체 관통, 사람 개입 정확히 4회 ────────────────────


async def _realdb_session():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # story #4050 실측 — 이 partial unique index는 raw SQL 마이그(0217)로만 존재해
        # Base.metadata.create_all()이 못 만든다(story_ref_promoter의 mention 자동링크가
        # 승인카드 알림 메시지 안의 참조 토큰을 인덕할 때 ON CONFLICT 대상으로 씀 —
        # test_3561의 uq_members_org_system_publisher 패치와 동형 하네스 갭, 제품 결함 아님).
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


# story #4070 — 이 파일이 처음 겪고 고친 클래스(team_members 스키마 형상별 시드 분기)를
# conftest.seed_org_with_human_owner로 공용화(SSOT). test_4044가 이 픽스를 못 받아 같은
# 클래스의 FK 위반을 겪은 것이 계기 — 이 로컬 사본도 그 공용 헬퍼로 교체해 재발 표면을 줄인다.
from tests.conftest import seed_org_with_human_owner as _seed_org_with_owner


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember
    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="AC5 관통 실증"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition
    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(릴스·쇼츠)",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def test_full_nine_stage_walkthrough_apply_gates4_budget_publish_with_exactly_four_human_approvals():
    """⭐AC1 핵심 — apply(2슬롯 바인딩)→9 stage 순서대로 발행→게이트4가 정확히 그 4개
    stage에서만 자동 생성→각 게이트를 사람이 승인(정확히 4회, 그 밖의 5개 stage는 PO
    스크립트나 사람 개입 없이 에이전트가 그냥 지나간다)→마지막 published까지 완주.
    AC5("PO 스크립트 0회·사람 개입 ≤4")를 코드로 못박는다.

    story #4051(#4428 착지) — mention_parser의 partial-index 파라미터화 결함이 근본
    수정돼 recipe_role_binding broadcast 알림 경로의 entity_references 반영이 실제로
    안전해졌다 — 이전엔 이 경로를 no-op으로 격리했으나(이 카드 스코프 밖 사전 확인된
    버그였음), fix 着地 후 그 격리를 걷어내고 실 경로 그대로 관통시킨다.

    PO 지적(2026-09-19) — 사람 개입 4회 중 3회가 `set_gate_status` DB 직접조작이었다
    (실제 라우트가 타는 `transition_gate` 경로 아님 — AC5가 검증하려는 "백엔드 경로가
    실제로 서는지"를 못 본다). 4회 전부 `transition_gate`(gates 라우터가 부르는 그
    서비스 함수)로 정정 — DB shortcut 0."""
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, EventPublishRequest,
        apply_recipe_role_bindings, publish_registry_event,
    )
    from app.services.content_rules import put_org_content_rules
    from app.services.gate_service import transition_gate
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from datetime import datetime, timezone
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug="r4050walk")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            creator_id = await _seed_agent(s, org_id, project_id, name="댄-크리에이터")
            publisher_id = await _seed_agent(s, org_id, project_id, name="담롱-발행자")
            story_id = await _seed_story(s, org_id, project_id)
            definition = await _seed_definition(s)

            # 예산 정책 — ⓒ게이트가 실제로 판정할 잔량이 있어야 "예산" 관통이 의미 있다.
            await put_org_content_rules(
                s, org_id=org_id,
                rules={"generation_budget": {"limit_minor": 500_000, "currency": "KRW", "period": "month"}},
                expected_version=0, updated_by_member_id=None,
            )

            # ── AC1-a: apply — 크리에이터 4stage + 발행자 1stage 바인딩. PO 스크립트 0회
            # (role_mapping 하나로 5개 슬롯을 한 호출에 upsert — 반복 수동 개입 없음).
            apply_resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={
                    "draft": str(creator_id), "animatic": str(creator_id),
                    "verification": str(creator_id), "editing": str(creator_id),
                    "published": str(publisher_id),
                }),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert apply_resp.ok is True
            assert apply_resp.bindings_upserted == 5

            human_approvals = 0

            async def _publish(stage: str, *, actor_id: uuid.UUID, extra: dict | None = None):
                payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
                if extra:
                    payload.update(extra)
                await publish_registry_event(
                    EventPublishRequest(definition_key=_KEY, payload=payload),
                    BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
                )

            # ── AC1-b: 9 stage 순서대로 관통. 게이트 없는 5개는 에이전트가 그냥 통과(사람
            # 개입 0), 게이트 있는 4개는 발행 즉시 pending Gate가 서고 사람(org_owner)이
            # 승인해야 다음으로 "넘어간다"는 서사가 성립(멈추는 자리가 정확히 여기).
            await _publish("draft", actor_id=creator_id)

            await _publish("concept_confirmed", actor_id=creator_id)
            gate_a = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
            )).scalar_one()
            assert gate_a.status == "pending"
            await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
            await s.commit()
            human_approvals += 1

            await _publish("animatic", actor_id=creator_id)
            gate_b = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
            )).scalar_one()
            assert gate_b.status == "pending"
            await transition_gate(s, org_id, gate_b.id, "approved", owner_member_id, None)
            await s.commit()
            human_approvals += 1

            # ⓒ 예산 — 편당 예상 비용을 실어 발행(director 역할, apply 바인딩 없음 =
            # gate.approver=org_owner로만 해소되는 자리라는 것 자체가 AC2 결론의 일부).
            await _publish(
                "structure_passed", actor_id=owner_member_id,
                extra={"estimated_cost_minor": 80_000},
            )
            gate_c = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "generation_budget")
            )).scalar_one()
            assert gate_c.status == "pending"
            assert gate_c.sealed_estimated_cost_minor == 80_000
            assert gate_c.neutral_facts["budget_remaining_minor"] == 500_000
            await transition_gate(s, org_id, gate_c.id, "approved", owner_member_id, None)
            await s.commit()
            human_approvals += 1

            # live_generation — "연산" 슬롯. apply 바인딩 대상이 아니었다(캐스팅 없음) —
            # 그래도 stage 이벤트 발행 자체는 막히지 않는다(recipe_role_binding 라우팅이
            # 빈 집합을 반환할 뿐, 이벤트 발행은 fail-open — AC2 결론의 실측).
            await _publish("live_generation", actor_id=owner_member_id)

            await _publish("verification", actor_id=creator_id)
            await _publish("editing", actor_id=creator_id)

            await _publish("pending_approval", actor_id=publisher_id)
            gate_d = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "external_publish")
            )).scalar_one()
            assert gate_d.status == "pending"
            # transition_gate(실 라우터 경로와 동일 함수) — approved 전이가 실제로
            # _maybe_create_scheduled_publication_command를 부르는지까지 실증.
            await transition_gate(s, org_id, gate_d.id, "approved", owner_member_id, None)
            await s.commit()
            human_approvals += 1

            await _publish("published", actor_id=publisher_id)

            # ── AC5 "사람 개입 ≤4" — 정확히 4회(그 이상 필요 없었다).
            assert human_approvals == 4

            # ── 게이트4 전부 approved, 그 4개 stage에서만 생성됐다(그 밖 5곳엔 게이트 0).
            all_gates = (await s.execute(select(Gate).where(Gate.work_item_id == story_id))).scalars().all()
            assert len(all_gates) == 4
            assert {g.gate_type for g in all_gates} == {
                "concept_approval", "structure_approval", "generation_budget", "external_publish",
            }
            assert all(g.status == "approved" for g in all_gates)

            # ── AC2/AC3 핵심 실측 — external_publish 승인이 실제 채널 발행 커맨드를
            # 만들지 않는다(우리 게이트엔 draft_id 연결이 없다 — "발행자" 슬롯의 실행은
            # BYOA 에이전트 자신의 몫이라는 결론의 직접 증거).
            commands = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.org_id == org_id)
            )).scalars().all()
            assert commands == []
            # sealed_scheduled_at이 없어(channel_posts.py 전용 필드, 우리 훅은 안 씀)
            # _maybe_create_scheduled_publication_command가 경고 로그조차 없이 조기
            # return한다는 실측 — resolution_note가 안 남는 게 "조용한 결함"이 아니라
            # "채널 발행 개념이 아예 이 축에 없다"는 사실 자체다.
            assert gate_d.resolution_note is None
    finally:
        await engine.dispose()
