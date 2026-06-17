"""project_access.role 1급 enum 토대 — 백필 + CHECK (E-MEMBER-POLICY S1, 44434ce9).

HITL 게이팅(hitl-gating-policy-v1 §2)의 선행 토대. project_access.role 을 free-text →
enum(owner/admin/member)으로 제약한다. role 은 프로젝트 역할의 단일 SSOT(projects.owner 컬럼
신설 안 함 — dual-SSOT 트랩 회피).

prod-safe 순서(dev/prod 공유 Cloud SQL — "dev" migrate 가 prod DB 에도 적용):
  1. 값 백필 먼저 — 비-enum role(레거시 'manager'·junk·NULL) → 'member'.
  2. can_manage_members=true 인데 role='member' → 'admin' (AC#3 실값 매핑; owner 다운그레이드 안 함).
  3. CHECK ADD NOT VALID → VALIDATE (lock-light; 백필 후라 검증 통과 보장).
컬럼 drop 없음 · can_manage_members 유지(무회귀·role 에서 derived) · 초기 owner stamp 안 함
(org-owner 상속·§9-1, guess-backfill 회피). 모든 write 경로는 clamp_project_role 로 enum 보장(선행 게이트).

idempotent: 재실행·fresh DB 안전 — 백필 UPDATE 멱등, CHECK 는 부재 시에만 ADD.
"""
from alembic import op

revision = "0122"
down_revision = "0121"
branch_labels = None
depends_on = None

_CK = "ck_project_access_role"


def upgrade() -> None:
    # 1. 비-enum role → member (레거시 'manager'·junk·NULL 정규화)
    op.execute(
        "UPDATE project_access SET role = 'member' "
        "WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'member')"
    )
    # 2. can_manage_members=true & role='member' → admin (AC#3: 관리권 보유=admin 실값 매핑)
    op.execute(
        "UPDATE project_access SET role = 'admin' "
        "WHERE can_manage_members = true AND role = 'member'"
    )
    # 3. CHECK NOT VALID → VALIDATE (멱등: 이미 있으면 skip)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = '{_CK}'
            ) THEN
                ALTER TABLE project_access
                  ADD CONSTRAINT {_CK} CHECK (role IN ('owner', 'admin', 'member')) NOT VALID;
                ALTER TABLE project_access VALIDATE CONSTRAINT {_CK};
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(f"ALTER TABLE project_access DROP CONSTRAINT IF EXISTS {_CK}")
