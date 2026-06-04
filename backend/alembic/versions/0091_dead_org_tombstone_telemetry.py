"""E-MEMBER-SSOT AC3-5 ⑥④: orphan telemetry + dead-org tombstone(soft·가역).

⑥ orphan telemetry(선행): orphan-org(org_id가 organizations에 부재) members/org_members + orphan
project_access grant(org_member 부재) + dead revoked api_key 카운트를 RAISE NOTICE로 관측(purge 전).

④ dead-org tombstone(soft-delete·가역, 하드삭제 0): orphan-org members/org_members를 deleted_at=now()로
tombstone. org 부재라 도달 경로 0(인가 불가)인 dead 신원. **하드 DELETE 안 함** → 복구 경로 = deleted_at
NULL(downgrade가 수행). a52b4ccd(orphan-org dead agent) 포함.

⚠️ project_access orphan grant은 deleted_at 컬럼이 없어 soft-delete 불가 → 본 마이그는 **telemetry만**
(하드 purge는 tombstone soak 후 별도 결정 — 가역 우선·purge 범위 최소화). org 부재라 inert(접근 경로 0).

③ team_member_id deprecated는 코드(스키마/모델 주석) 표식 — 컬럼 dual 유지(DDL 변경 없음).

Revision ID: 0091
Revises: 0090
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0091"
down_revision = "0090"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE m int; om int; pa int; ak int;
        BEGIN
            -- ⑥ telemetry(선행): orphan 클래스 카운트(purge 전 관측)
            SELECT count(*) INTO m FROM members
             WHERE org_id NOT IN (SELECT id FROM organizations) AND deleted_at IS NULL;
            SELECT count(*) INTO om FROM org_members
             WHERE org_id NOT IN (SELECT id FROM organizations) AND deleted_at IS NULL;
            -- orphan grant = org_member 행 부재 OR org_member가 orphan-org(진짜 dead-org grant 클래스)
            SELECT count(*) INTO pa FROM project_access p
             WHERE p.org_member_id IS NOT NULL
               AND (p.org_member_id NOT IN (SELECT id FROM org_members)
                    OR p.org_member_id IN (SELECT id FROM org_members
                                            WHERE org_id NOT IN (SELECT id FROM organizations)));
            SELECT count(*) INTO ak FROM agent_api_keys
             WHERE member_id IS NULL AND revoked_at IS NOT NULL;
            RAISE NOTICE 'AC3-5 telemetry: orphan-org members=% org_members=% / orphan project_access(org_member 부재)=% / dead revoked api_keys=%', m, om, pa, ak;

            -- ④ dead-org tombstone(soft·가역, 하드삭제 0): orphan-org members/org_members
            -- ⚠️ 방어 가드: organizations 빈 테이블이면 `NOT IN (빈집합)=TRUE`로 전원 tombstone되는
            --    파국 회피(현실 불가능하나 마이그 안전). organizations 비어있으면 스킵.
            IF EXISTS (SELECT 1 FROM organizations) THEN
                UPDATE members SET deleted_at = now()
                 WHERE org_id NOT IN (SELECT id FROM organizations) AND deleted_at IS NULL;
                UPDATE org_members SET deleted_at = now()
                 WHERE org_id NOT IN (SELECT id FROM organizations) AND deleted_at IS NULL;
            ELSE
                RAISE NOTICE 'AC3-5 tombstone 스킵: organizations 비어있음(파국 방지 가드)';
            END IF;
            RAISE NOTICE 'AC3-5 tombstone: orphan-org members/org_members deleted_at 설정(하드삭제 0·복구=deleted_at NULL). project_access orphan grant=% 건은 telemetry만(하드 purge 보류)', pa;
        END $$;
        """
    )


def downgrade() -> None:
    # 가역: 본 마이그 tombstone 복구(deleted_at NULL). orphan-org 조건 동일 — 적용분만 되돌림.
    op.execute("UPDATE members SET deleted_at = NULL WHERE org_id NOT IN (SELECT id FROM organizations)")
    op.execute("UPDATE org_members SET deleted_at = NULL WHERE org_id NOT IN (SELECT id FROM organizations)")
