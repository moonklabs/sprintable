-- E-DATA-INTEGRITY S1: epics 테이블 스키마 강화
-- status CHECK 제약 + 계약서 컬럼 4개 추가

-- 1. 기존 status 무효값 정리 (open → active)
UPDATE epics
  SET status = 'active'
  WHERE status NOT IN ('draft', 'active', 'done', 'archived');

-- 2. status CHECK 제약 추가
ALTER TABLE epics
  ADD CONSTRAINT epics_status_check
    CHECK (status IN ('draft', 'active', 'done', 'archived'));

-- 3. 계약서 컬럼 4개 추가 (전부 nullable)
ALTER TABLE epics ADD COLUMN IF NOT EXISTS objective        TEXT;
ALTER TABLE epics ADD COLUMN IF NOT EXISTS success_criteria TEXT;
ALTER TABLE epics ADD COLUMN IF NOT EXISTS target_sp        INTEGER;
ALTER TABLE epics ADD COLUMN IF NOT EXISTS target_date      DATE;
