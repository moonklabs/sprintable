-- docs 참조 FK 패리티 감사 + orphan preflight (story 5b246134 · docs 참조 FK 복구)
--
-- 목적:
--   (1) docs(.id)를 참조해야 할 컬럼들의 실 DB FK 실태 — baseline schema.sql엔 docs 참조 FK 전무
--       (0007 doc_comments.doc_id/doc_revisions.doc_id FK 소실 추정). 어떤 게 실재/소실인지 확정.
--   (2) orphan row 수 — doc_id(또는 참조 컬럼)가 non-NULL인데 docs에 매칭 없는 깨진 참조. FK ADD는
--       orphan 있으면 실패하므로 복구 마이그 전 전수. orphan>0이면 정리/보존 결정 선행(머지 블로커).
--
-- ⚠️ READ-ONLY. SELECT만 — 데이터/스키마 변경 없음. dev(at head) 실행 — doc_slug_aliases·
--    doc_share_tokens는 post-0096 마이그 산물이라 baseline엔 없으나 head DB엔 존재.
-- 실행: Private-IP DB → Cloud Run 일회성 잡(psql/SQL 러너). 순수 SQL·section 라벨 자기설명.
-- 참조: [[reference_privateip_db_diag_and_project_authz]] · plan_features_schema_audit.sql 동형.
--
-- 후보(table.column → docs.id, ORM ondelete):
--   doc_comments.doc_id(CASCADE NN)·doc_revisions.doc_id(CASCADE NN)·doc_slug_aliases.doc_id
--   (CASCADE NN)·doc_share_tokens.doc_id(CASCADE NN)·docs.parent_id(SET NULL null)·
--   sprints.report_doc_id(SET NULL null)·epic_docs.doc_id(link NN)·story_docs.doc_id(link NN)·
--   memo_doc_links.doc_id(link NN)

-- ── [1] 현존 docs-참조 FK 일람 (전무 가설 검증 — 비면 0건 = 전 FK 소실) ────────────
SELECT
    '1_existing_fks'                AS section,
    conrelid::regclass::text        AS table_name,
    conname                         AS fk_name,
    pg_get_constraintdef(oid)       AS definition
FROM pg_constraint
WHERE contype = 'f'
  AND confrelid = to_regclass('public.docs')
ORDER BY conrelid::regclass::text, conname;

-- ── [2] orphan 감사 (orphan_cnt>0 = FK ADD 블로커·정리/보존 결정 필요) ───────────
SELECT '2_orphans' AS section, t.table_name, t.column_name, t.total_nonnull, t.orphan_cnt
FROM (
    SELECT 'doc_comments'::text AS table_name, 'doc_id'::text AS column_name,
        (SELECT count(*) FROM doc_comments WHERE doc_id IS NOT NULL) AS total_nonnull,
        (SELECT count(*) FROM doc_comments x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id)) AS orphan_cnt
    UNION ALL SELECT 'doc_revisions', 'doc_id',
        (SELECT count(*) FROM doc_revisions WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM doc_revisions x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
    UNION ALL SELECT 'doc_slug_aliases', 'doc_id',
        (SELECT count(*) FROM doc_slug_aliases WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM doc_slug_aliases x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
    UNION ALL SELECT 'doc_share_tokens', 'doc_id',
        (SELECT count(*) FROM doc_share_tokens WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM doc_share_tokens x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
    UNION ALL SELECT 'docs', 'parent_id',
        (SELECT count(*) FROM docs WHERE parent_id IS NOT NULL),
        (SELECT count(*) FROM docs x WHERE x.parent_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.parent_id))
    UNION ALL SELECT 'sprints', 'report_doc_id',
        (SELECT count(*) FROM sprints WHERE report_doc_id IS NOT NULL),
        (SELECT count(*) FROM sprints x WHERE x.report_doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.report_doc_id))
    UNION ALL SELECT 'epic_docs', 'doc_id',
        (SELECT count(*) FROM epic_docs WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM epic_docs x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
    UNION ALL SELECT 'story_docs', 'doc_id',
        (SELECT count(*) FROM story_docs WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM story_docs x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
    UNION ALL SELECT 'memo_doc_links', 'doc_id',
        (SELECT count(*) FROM memo_doc_links WHERE doc_id IS NOT NULL),
        (SELECT count(*) FROM memo_doc_links x WHERE x.doc_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM docs d WHERE d.id = x.doc_id))
) t
ORDER BY t.table_name, t.column_name;
