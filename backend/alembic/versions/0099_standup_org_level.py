"""E-STANDUP 3b6b567c: standup_entries org-level 재설계 (project-level → org-level).

기존: app-level upsert 키 (project_id, author_id, date) — 같은 author+date 가 프로젝트마다
별도 엔트리. (DB-level UNIQUE 는 부재 — 순수 app-level.)
목표: (org_id, author_id, date) 단위 1엔트리. 프로젝트 surface 는 standup_entry_projects
link 로 projection (51447ca0). write 링크 채우기는 1c2be9db(write API) 스코프.

이 마이그(3b6b567c):
1. standup_entry_projects link table 신설 + 기존 project_id 에서 backfill.
2. preflight dedupe (0081 패턴·PARTITION (org_id,author_id,date)):
   - feedback 를 keeper 로 reattach **先**, 잉여 entry DELETE **後** (CP2 — 순서 틀리면 FK
     CASCADE 로 feedback 소멸).
   - keeper = latest updated_at. done/plan/blockers 는 그룹 내 **distinct non-empty 값을
     provenance 구분자로 MERGE**(winner 값 + 상이한 비-winner 값 append) → **내용 0 소실**
     (PO ①·dev lossy_rows=1 실적출 → winner-only 폐기). plan_story_ids 는 그룹 union.
   - CP4: 구분자 project name JOIN soft-deleted/NULL → project:<id> 폴백.
   - 머지 그룹 RAISE NOTICE 로그(rollback·감사 재현).
3. project_id DROP NOT NULL — 단, 값은 keeper origin 보존(NULL 미도입) → 기존 project-filter
   read 무파손. 풀 projection 은 link join(51447ca0).
4. UNIQUE(org_id, author_id, date) 추가(현재 DB-level unique 부재 → 신규).

멱등: IF NOT EXISTS·ON CONFLICT DO NOTHING·dedupe 재실행 시 단일행 그룹이면 no-op.
롤백: 구조 revert(unique index·link table drop). 데이터 MERGE 는 비가역(0081 동일 정책).

Revision ID: 0099
Revises: 0098
Create Date: 2026-06-05
"""
from __future__ import annotations

from alembic import op

revision = "0099"
down_revision = "0098"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 0. 잠재 갭 하드닝: standup_entries.id 에 unique 보장 ────────────────────
    # dev 실측상 standup_entries 는 PK/unique 제약이 부재(모델은 primary_key=True 이나 DB 미반영).
    # link table FK(REFERENCES standup_entries(id)) 가 성립하려면 id 가 unique 여야 한다.
    # 멱등(IF NOT EXISTS) — fresh DB(PK 보유)에선 중복 무해, dev(PK 부재)에선 FK 가능화.
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_standup_entries_id ON standup_entries (id)")

    # ── 1. link table + backfill ──────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS standup_entry_projects (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            entry_id uuid NOT NULL REFERENCES standup_entries(id) ON DELETE CASCADE,
            project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            org_id uuid NOT NULL,
            CONSTRAINT uq_standup_entry_project UNIQUE (entry_id, project_id)
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_sep_entry_id ON standup_entry_projects(entry_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sep_project_id ON standup_entry_projects(project_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_sep_org_id ON standup_entry_projects(org_id)")
    op.execute(
        """
        INSERT INTO standup_entry_projects (id, entry_id, project_id, org_id)
        SELECT gen_random_uuid(), se.id, se.project_id, se.org_id
        FROM standup_entries se
        WHERE se.project_id IS NOT NULL
          -- dev 실측: standup_entries 가 under-constrained(PK·FK 미enforced)라 orphan
          -- project_id(하드삭제된 프로젝트 참조)가 존재. link table 은 FK 를 강제하므로
          -- 존재하는 project 만 backfill (orphan 은 자연 제외 — projection 대상 아님).
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = se.project_id)
        ON CONFLICT (entry_id, project_id) DO NOTHING
        """
    )

    # ── 2. preflight dedupe ───────────────────────────────────────────────────
    # 2a. feedback reattach → keeper (DELETE 先행 금지 — CP2)
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER w AS rn,
                   first_value(id) OVER w AS keeper
            FROM standup_entries
            WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC)
        )
        UPDATE standup_feedback sf SET standup_entry_id = r.keeper
        FROM ranked r
        WHERE sf.standup_entry_id = r.id AND r.rn > 1
        """
    )

    # 2b. keeper 가 그룹 내 모든 project 링크를 union 보유 (잉여행 DELETE 시 그들 링크는 CASCADE)
    op.execute(
        """
        WITH ranked AS (
            SELECT id, org_id, project_id,
                   first_value(id) OVER w AS keeper
            FROM standup_entries
            WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC)
        )
        INSERT INTO standup_entry_projects (id, entry_id, project_id, org_id)
        SELECT gen_random_uuid(), r.keeper, r.project_id, r.org_id
        FROM ranked r
        WHERE r.project_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = r.project_id)
        ON CONFLICT (entry_id, project_id) DO NOTHING
        """
    )

    # 2c. 머지 그룹 로그 (DELETE 前 — rollback·감사 재현)
    op.execute(
        """
        DO $$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT org_id, author_id, date, count(*) AS c
                FROM standup_entries
                GROUP BY org_id, author_id, date
                HAVING count(*) > 1
            LOOP
                RAISE NOTICE 'E-STANDUP 3b6b567c dedupe MERGE: org=% author=% date=% rows=%',
                    r.org_id, r.author_id, r.date, r.c;
            END LOOP;
        END $$
        """
    )

    # 2d. text MERGE (winner 값 + 상이한 비-winner non-empty 값 provenance append) + plan_story_ids union
    #     CP4: project name NULL/soft-deleted → project:<id> 폴백 (LEFT JOIN 으로 행 자체는 확보).
    op.execute(
        """
        WITH ranked AS (
            SELECT id, org_id, author_id, date,
                   row_number() OVER w AS rn,
                   first_value(id) OVER w AS keeper,
                   count(*) OVER w AS cnt
            FROM standup_entries
            WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC)
        ),
        keepers AS (
            SELECT k.id, k.org_id, k.author_id, k.date, k.done, k.plan, k.blockers
            FROM standup_entries k
            JOIN ranked r ON r.id = k.id
            WHERE r.rn = 1 AND r.cnt > 1
        )
        UPDATE standup_entries t SET
            done = CASE WHEN sfx.done_sfx = '' THEN t.done
                        ELSE COALESCE(t.done, '') || sfx.done_sfx END,
            plan = CASE WHEN sfx.plan_sfx = '' THEN t.plan
                        ELSE COALESCE(t.plan, '') || sfx.plan_sfx END,
            blockers = CASE WHEN sfx.blk_sfx = '' THEN t.blockers
                            ELSE COALESCE(t.blockers, '') || sfx.blk_sfx END,
            plan_story_ids = COALESCE(sfx.psids, t.plan_story_ids)
        FROM keepers kp
        CROSS JOIN LATERAL (
            SELECT
                COALESCE((
                    SELECT string_agg(
                        '\n\n--- merged from project: ' ||
                        COALESCE(NULLIF(p.name, ''), se2.project_id::text) || ' ---\n' || se2.done,
                        '' ORDER BY se2.updated_at DESC, se2.id DESC)
                    FROM standup_entries se2 LEFT JOIN projects p ON p.id = se2.project_id
                    WHERE se2.org_id = kp.org_id AND se2.author_id = kp.author_id AND se2.date = kp.date
                      AND se2.id <> kp.id
                      AND COALESCE(se2.done, '') <> '' AND COALESCE(se2.done, '') <> COALESCE(kp.done, '')
                ), '') AS done_sfx,
                COALESCE((
                    SELECT string_agg(
                        '\n\n--- merged from project: ' ||
                        COALESCE(NULLIF(p.name, ''), se2.project_id::text) || ' ---\n' || se2.plan,
                        '' ORDER BY se2.updated_at DESC, se2.id DESC)
                    FROM standup_entries se2 LEFT JOIN projects p ON p.id = se2.project_id
                    WHERE se2.org_id = kp.org_id AND se2.author_id = kp.author_id AND se2.date = kp.date
                      AND se2.id <> kp.id
                      AND COALESCE(se2.plan, '') <> '' AND COALESCE(se2.plan, '') <> COALESCE(kp.plan, '')
                ), '') AS plan_sfx,
                COALESCE((
                    SELECT string_agg(
                        '\n\n--- merged from project: ' ||
                        COALESCE(NULLIF(p.name, ''), se2.project_id::text) || ' ---\n' || se2.blockers,
                        '' ORDER BY se2.updated_at DESC, se2.id DESC)
                    FROM standup_entries se2 LEFT JOIN projects p ON p.id = se2.project_id
                    WHERE se2.org_id = kp.org_id AND se2.author_id = kp.author_id AND se2.date = kp.date
                      AND se2.id <> kp.id
                      AND COALESCE(se2.blockers, '') <> '' AND COALESCE(se2.blockers, '') <> COALESCE(kp.blockers, '')
                ), '') AS blk_sfx,
                (
                    SELECT array_agg(DISTINCT x)
                    FROM standup_entries se3, unnest(se3.plan_story_ids) AS x
                    WHERE se3.org_id = kp.org_id AND se3.author_id = kp.author_id AND se3.date = kp.date
                ) AS psids
        ) sfx
        WHERE t.id = kp.id
        """
    )

    # 2e. 잉여행 DELETE (feedback reattach·링크 union·merge 완료 後)
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   row_number() OVER (PARTITION BY org_id, author_id, date
                                      ORDER BY updated_at DESC, id DESC) AS rn
            FROM standup_entries
        )
        DELETE FROM standup_entries se USING ranked r WHERE se.id = r.id AND r.rn > 1
        """
    )

    # ── 3. project_id nullable (값 보존 — NULL 도입 안 함) ─────────────────────
    op.execute("ALTER TABLE standup_entries ALTER COLUMN project_id DROP NOT NULL")

    # ── 4. org-level UNIQUE (현재 DB-level unique 부재 → 신규 추가) ────────────
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_standup_org_author_date "
        "ON standup_entries (org_id, author_id, date)"
    )


def downgrade() -> None:
    # 구조 revert. 데이터 MERGE(복수 project-entry → 1 org-entry, 텍스트 병합)는 비가역
    # (0081·0075 동일 정책 — no-op 데이터). project_id 는 NULL 도입을 안 했으나 1c2be9db
    # org-level write 이후 NULL 이 생길 수 있어 NOT NULL 복원은 생략(안전).
    op.execute("DROP INDEX IF EXISTS uq_standup_org_author_date")
    op.execute("DROP TABLE IF EXISTS standup_entry_projects")
