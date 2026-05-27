"""ws-chat 전용 conversation → DM conversation 이관 (E-FAKECHAT-INTEG)

Revision ID: 0051
Revises: 0050
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def _find_or_create_dm(conn, agent_id: str, caller_id: str, org_id: str, project_id: str, now) -> str:
    """에이전트↔사용자 DM conversation 조회 또는 생성. dm_id(str) 반환."""
    existing = conn.execute(
        sa.text(
            "SELECT c.id FROM conversations c "
            "JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.member_id = :agent_id "
            "JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.member_id = :caller_id "
            "WHERE c.type = 'dm' AND c.org_id = :org_id AND c.project_id = :project_id "
            "AND c.status != 'deleted' LIMIT 1"
        ),
        {"agent_id": agent_id, "caller_id": caller_id, "org_id": org_id, "project_id": project_id},
    ).fetchone()

    if existing:
        return str(existing.id)

    dm_id = str(uuid.uuid4())
    conn.execute(
        sa.text(
            "INSERT INTO conversations "
            "(id, org_id, project_id, type, title, status, created_by, created_at, updated_at) "
            "VALUES (:id, :org_id, :project_id, 'dm', NULL, 'open', :agent_id, :now, :now)"
        ),
        {"id": dm_id, "org_id": org_id, "project_id": project_id, "agent_id": agent_id, "now": now},
    )
    for mid in [agent_id, caller_id]:
        conn.execute(
            sa.text(
                "INSERT INTO conversation_participants "
                "(id, conversation_id, member_id, joined_at) "
                "VALUES (gen_random_uuid(), :conv_id, :member_id, :now) "
                "ON CONFLICT ON CONSTRAINT uq_conversation_participant DO NOTHING"
            ),
            {"conv_id": dm_id, "member_id": mid, "now": now},
        )
    return dm_id


def upgrade() -> None:
    conn = op.get_bind()
    now = datetime.now(timezone.utc)

    # 1. ws-chat:{agent_id} 전용 conversation 전체 조회
    ws_chats = conn.execute(
        sa.text(
            "SELECT id, title, org_id, project_id FROM conversations "
            "WHERE title LIKE 'ws-chat:%' AND status != 'deleted'"
        )
    ).fetchall()

    for wsc in ws_chats:
        conv_id = str(wsc.id)
        title: str = wsc.title
        org_id = str(wsc.org_id)
        project_id = str(wsc.project_id)
        agent_id = title[len("ws-chat:"):]

        # 2. non-agent 발신자 목록 조회
        senders = conn.execute(
            sa.text(
                "SELECT DISTINCT cm.sender_id FROM conversation_messages cm "
                "JOIN team_members tm ON tm.id = cm.sender_id "
                "WHERE cm.conversation_id = :cid AND tm.type != 'agent'"
            ),
            {"cid": conv_id},
        ).fetchall()
        caller_ids = [str(s.sender_id) for s in senders]

        if caller_ids:
            # 3. agent 메시지 이관 대상 — 메시지 이관 전에 가장 활발한 caller 확인
            most_active_row = conn.execute(
                sa.text(
                    "SELECT sender_id FROM conversation_messages "
                    "WHERE conversation_id = :cid AND sender_id != :agent_id "
                    "GROUP BY sender_id ORDER BY COUNT(*) DESC LIMIT 1"
                ),
                {"cid": conv_id, "agent_id": agent_id},
            ).fetchone()
            most_active_caller = str(most_active_row.sender_id) if most_active_row else caller_ids[0]

            # 4. caller별 DM 생성/조회 + caller 발신 메시지 이관
            caller_dm_map: dict[str, str] = {}
            for caller_id in caller_ids:
                dm_id = _find_or_create_dm(conn, agent_id, caller_id, org_id, project_id, now)
                caller_dm_map[caller_id] = dm_id
                conn.execute(
                    sa.text(
                        "UPDATE conversation_messages SET conversation_id = :dm_id "
                        "WHERE conversation_id = :old_id AND sender_id = :caller_id"
                    ),
                    {"dm_id": dm_id, "old_id": conv_id, "caller_id": caller_id},
                )

            # 5. agent 발신 메시지 → 가장 활발한 caller의 DM으로 이관
            primary_dm = caller_dm_map.get(most_active_caller, next(iter(caller_dm_map.values())))
            conn.execute(
                sa.text(
                    "UPDATE conversation_messages SET conversation_id = :dm_id "
                    "WHERE conversation_id = :old_id"
                ),
                {"dm_id": primary_dm, "old_id": conv_id},
            )

        # 6. ws-chat conv soft delete
        conn.execute(
            sa.text("UPDATE conversations SET status = 'deleted' WHERE id = :cid"),
            {"cid": conv_id},
        )


def downgrade() -> None:
    # 데이터 이관은 되돌릴 수 없음 — no-op
    pass
