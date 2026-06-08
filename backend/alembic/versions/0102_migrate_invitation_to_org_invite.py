"""migrate Invitation(pending) → org_invites (token 보존·수락 정합) — d3619e80 S1

dual-live 초대 시스템 통합: 구 invitations(Invitation) 테이블의 pending 초대를
canonical org_invites(OrgInvite)로 이전한다. **token 보존이 핵심** — Invitation.token 을
그대로 OrgInvite.token 으로 옮기면, 기존 invite_url(/invite/accept?token)이 invite_accept
(OrgInvite repo) 조회와 매칭되어 **그동안 깨져 있던(404) settings 초대 수락이 정합**된다.
(데이터 보존 + 수락 broken 실버그 동시 해소.)

- additive: invitations 테이블/행 유지(③ FE cutover 後 별도 DROP). non-breaking.
- 멱등: 동일 token 의 org_invites 행 없을 때만 INSERT(재실행 안전).
- 대상: pending + 미만료만(만료/수락완료는 이전 불요).
- created_by: OrgInvite.created_by FK=users.id 이므로 Invitation.invited_by(canonical
  members.id)를 members.user_id 로 역추적(휴먼 초대자=user_id 보유·orphan/agent=NULL SET).
- project_id(단일 uuid) → project_ids(JSONB 문자열 uuid 배열·null이면 []·0097 정합).

Revision ID: 0102
Revises: 0101
Create Date: 2026-06-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0102"
down_revision = "0101"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("""
            INSERT INTO org_invites (
                id, organization_id, email, role, token, status,
                expires_at, accepted_at, created_by, created_at,
                email_sent_at, email_error, project_ids
            )
            SELECT
                gen_random_uuid(),
                i.org_id,
                i.email,
                i.role,
                i.token,
                i.status,
                i.expires_at,
                i.accepted_at,
                (SELECT m.user_id FROM members m WHERE m.id = i.invited_by),
                i.created_at,
                i.email_sent_at,
                i.email_error,
                CASE
                    WHEN i.project_id IS NOT NULL
                    THEN jsonb_build_array(i.project_id::text)
                    ELSE '[]'::jsonb
                END
            FROM invitations i
            WHERE i.status = 'pending'
              AND i.expires_at > now()
              AND NOT EXISTS (
                  SELECT 1 FROM org_invites o WHERE o.token = i.token
              )
        """)
    )


def downgrade() -> None:
    # additive 이전 — 원본 invitations 가 보존되므로 rollback 시 손실 없음.
    # token 으로 이전 행 식별 가능하나, 사용자가 마이그 後 생성한 동일-token 행은
    # 사실상 없으므로(token unique) token 기준 삭제도 안전. 보수적으로 no-op.
    pass
