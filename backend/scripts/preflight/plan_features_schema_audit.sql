-- plan_features 실스키마 감사 + 0120 PK preflight (story e491d087 · #1519)
--
-- 목적:
--   (1) 실 컬럼 introspection으로 드리프트 확정 — Ⓐ ORM/0049(code/name/tier/is_active...)
--       vs Ⓑ baseline schema.sql(tier_id/feature_key/enabled/limit_value). baseline 반영
--       방향(0120 baseline 컬럼 정합 후속)을 이 결과로 결정.
--   (2) 0120 ADD PRIMARY KEY(id) preflight — id NULL/중복 0건이어야 GO(있으면 머지 블로커).
--
-- ⚠️ READ-ONLY. SELECT만 — 데이터/스키마 변경 없음. dev·prod 양쪽 동일 실행.
-- 실행: Private-IP DB라 로컬 psql 불가 → Cloud Run 일회성 잡(psql 또는 SQL 러너)로 주입.
--       psql 백슬래시 메타명령 미사용(순수 SQL) — 어떤 실행기로도 동일 출력. 각 결과셋은
--       section 라벨 컬럼으로 자기설명.
-- 참조: [[reference_privateip_db_diag_and_project_authz]]

-- ── [1] 컬럼 introspection (ⒶvsⒷ 판정의 1차 근거) ──────────────────────────────
SELECT
    '1_columns'        AS section,
    ordinal_position   AS pos,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'plan_features'
ORDER BY ordinal_position;

-- ── [2] 제약 (PK 존재 여부 = 0120 사유 직접 확인) ──────────────────────────────
SELECT
    '2_constraints'              AS section,
    conname                      AS constraint_name,
    contype                      AS type,  -- p=PK, u=unique, f=FK, c=check
    pg_get_constraintdef(oid)    AS definition
FROM pg_constraint
WHERE conrelid = 'public.plan_features'::regclass
ORDER BY contype, conname;

-- ── [3] 인덱스 ────────────────────────────────────────────────────────────────
SELECT
    '3_indexes'  AS section,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'plan_features'
ORDER BY indexname;

-- ── [4] 행 수 ─────────────────────────────────────────────────────────────────
SELECT '4_rowcount' AS section, count(*) AS row_count FROM plan_features;

-- ── [5] 0120 PK preflight (id_null_cnt·id_dup_groups 둘 다 0이어야 GO) ─────────
SELECT
    '5_pk_preflight' AS section,
    (SELECT count(*) FROM plan_features WHERE id IS NULL) AS id_null_cnt,
    (SELECT count(*) FROM (
        SELECT id FROM plan_features GROUP BY id HAVING count(*) > 1
    ) d) AS id_dup_groups;
