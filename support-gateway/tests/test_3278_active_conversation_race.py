"""story #3278(지원v1·후속) — (org_id, external_user_id)당 활성 상담 최대 1개를
partial unique index(alembic/versions/0005_active_conversation_unique_index.py)로 강제 +
레이스 패자의 앱 레벨 우아한 처리(app/routers/sessions.py::_create_active_conversation_racesafe).

migration 0005 자체(실 PG에서 중복 INSERT가 실제로 막히는가·기존 중복 데이터 선-정리
UPDATE가 옳게 동작하는가·레거시 NULL external_user_id 행은 안 건드리는가)는 로컬 실
Postgres로 별도 수동 검증 완료(PR 본문 참고) — 이 스위트는 다른 gateway 테스트와 동일하게
sqlite 인메모리라 partial unique index 자체를 못 태운다(`Base.metadata.create_all`이
모델 정의만 보고, 이 인덱스는 마이그레이션 전용이라 모델엔 없음 — 0003의 기존 비-unique
인덱스와 동일한 이 코드베이스 관례). 그래서 여기는 IntegrityError를 monkeypatch로 주입해
"레이스에서 졌을 때 앱 코드가 올바르게 반응하는가"(우아한 처리 로직 자체)만 겨냥한다.

⚠️`app.routers.sessions`/`app.models`는 이 파일 **함수 안에서만** import한다(모듈 최상단
import는 collection 시점에 `app.db`(모듈 로드 시 즉시 엔진 생성)를 끌고 들어와
`_configure_settings` autouse 픽스처가 아직 안 걸린 상태의 실 `settings.database_url`
(빈 문자열)로 실패한다 — story #3279 test_3279_operator_reply.py 등 기존 파일들이 전부
이 지연 import 관례를 쓰는 이유와 동일)."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_session(db, *, org_id, external_user_id):
    from app.models import SupportSession

    session = SupportSession(id=uuid.uuid4(), org_id=org_id, external_user_id=external_user_id)
    db.add(session)
    await db.flush()
    return session


@pytest.mark.anyio
async def test_no_race_creates_new_conversation(db_engine):
    """양성대조 — 경쟁이 없으면(flush가 정상 성공) 그냥 새 상담을 만든다(기존 동작 무회귀)."""
    from app.routers.sessions import _create_active_conversation_racesafe

    Session = async_sessionmaker(db_engine, expire_on_commit=False)
    async with Session() as db:
        org_id, user_id = uuid.uuid4(), uuid.uuid4()
        session = await _seed_session(db, org_id=org_id, external_user_id=user_id)

        result = await _create_active_conversation_racesafe(
            db, session=session, org_id=org_id, external_user_id=user_id
        )
        await db.commit()

        assert result.org_id == org_id
        assert result.external_user_id == user_id


@pytest.mark.anyio
async def test_race_loser_reuses_winner_conversation_instead_of_500(db_engine):
    """⭐AC pin — flush()가 IntegrityError(unique 위반, 레이스 패배 시뮬레이션)를 던지면
    500을 흘려보내지 않고 이미 존재하는(=승자가 만든) 활성 상담을 그대로 돌려받는다."""
    from app.models import SupportConversation
    from app.routers.sessions import _create_active_conversation_racesafe, _get_active_conversation

    Session = async_sessionmaker(db_engine, expire_on_commit=False)
    async with Session() as db:
        org_id, user_id = uuid.uuid4(), uuid.uuid4()
        session = await _seed_session(db, org_id=org_id, external_user_id=user_id)
        # "승자"가 이미 커밋해 둔 활성 상담을 미리 심어둔다(레이스 결과를 흉내).
        winner = SupportConversation(org_id=org_id, session_id=session.id, external_user_id=user_id)
        db.add(winner)
        await db.commit()

        real_flush = db.flush
        call_count = {"n": 0}

        async def _flush_raise_once():
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise IntegrityError("insert into support_conversations", {}, Exception("duplicate key"))
            return await real_flush()

        db.flush = _flush_raise_once

        result = await _create_active_conversation_racesafe(
            db, session=session, org_id=org_id, external_user_id=user_id
        )

        assert result.id == winner.id  # 승자 재사용 — 새 행을 또 만들지 않음.
        assert call_count["n"] == 1  # flush는 정확히 한 번(실패한 그 한 번)만 시도됨.

    # 별도 세션으로 재조회 — DB 실측(같은 트랜잭션 안 self-confirm이 아니라).
    async with Session() as verify_db:
        active = await _get_active_conversation(verify_db, org_id=org_id, external_user_id=user_id)
        assert active is not None
        assert active.id == winner.id


@pytest.mark.anyio
async def test_race_loser_with_no_winner_found_reraises(db_engine):
    """방어적 재-raise pin — IntegrityError는 났는데(이론상 불가능해야 함) 재조회해도
    승자 행이 없으면, 조용히 삼켜 원인불명 500/무한루프를 만들지 않고 원래 에러를 그대로
    다시 던진다."""
    from app.routers.sessions import _create_active_conversation_racesafe

    Session = async_sessionmaker(db_engine, expire_on_commit=False)
    async with Session() as db:
        org_id, user_id = uuid.uuid4(), uuid.uuid4()
        session = await _seed_session(db, org_id=org_id, external_user_id=user_id)
        await db.commit()

        async def _flush_always_raise():
            raise IntegrityError("insert into support_conversations", {}, Exception("duplicate key"))

        db.flush = _flush_always_raise

        with pytest.raises(IntegrityError):
            await _create_active_conversation_racesafe(
                db, session=session, org_id=org_id, external_user_id=user_id
            )
