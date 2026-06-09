"""E-FILE S2: conversation_messages.attachments 마이그(0093) + 모델 정합 검증.

실 DB 적용은 sprintable-migrate-dev(asyncpg)로 별도 확인 — CI(SQLite)는 asyncpg
런타임을 못 잡으므로 여기선 마이그 파일 계약 + 모델 컬럼 정의만 잠근다.
"""
from __future__ import annotations

import importlib.util
import os

_MIGRATION = os.path.join(
    os.path.dirname(__file__), "..", "alembic", "versions",
    "0093_add_attachments_to_conversation_messages.py",
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0093", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0093_chains_off_0092():
    mod = _load_migration()
    assert mod.revision == "0093"
    assert mod.down_revision == "0092"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_model_has_attachments_jsonb_additive():
    """모델 컬럼: JSONB, nullable, server_default '[]' (additive·non-breaking)."""
    from sqlalchemy.dialects.postgresql import JSONB

    from app.models.conversation import ConversationMessage

    col = ConversationMessage.__table__.c.attachments
    assert isinstance(col.type, JSONB)
    assert col.nullable is True
    assert col.server_default is not None
    assert "[]" in str(col.server_default.arg)
