-- 0120 plan_features PRIMARY KEY 복원 — preflight (story e491d087 머지 게이트)
--
-- real dev/prod 양쪽에 실행. ADD PRIMARY KEY는 대상 컬럼에 NULL 또는 중복이 있으면 실패하므로,
-- 0120 머지/적용 전 plan_features.id 를 점검한다. null_cnt>0 또는 dup_groups>0 이면 데이터
-- 정리 선행이 필요(머지 블로커). 전 0이면 GO.
--
-- 실행: psql "$PROD_OR_DEV_URL" -f backend/scripts/preflight/0120_plan_features_pk_preflight.sql
-- (cloud-sql-proxy 경유 — reference_prod_db_query 참조. 인프라 lane.)
--
-- ⚠️ 참고: plan_features 컬럼 자체가 baseline(tier_id/feature_key)↔0049/ORM(code/name/tier)으로
-- drift돼 있다(별 트랙). 본 preflight는 양 버전 공통인 id 컬럼만 점검한다. real plan_features의
-- 실 컬럼(\d plan_features)도 같이 확인해 0049 버전(code/name/tier)인지 교차검증 권장.

\pset format aligned
SELECT 'plan_features' AS tbl, 'id' AS pk,
    (SELECT count(*) FROM plan_features WHERE "id" IS NULL) AS null_cnt,
    (SELECT count(*) FROM (SELECT "id" FROM plan_features GROUP BY "id" HAVING count(*) > 1) d) AS dup_groups;
