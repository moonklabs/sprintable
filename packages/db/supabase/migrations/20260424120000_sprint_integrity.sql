-- E-DATA-INTEGRITY S5: 스프린트 정합성 — 날짜/활성/Rollover

-- 1. 날짜 역전 데이터 정리 (start_date >= end_date인 행 → end_date를 start_date + 14일로 교정)
UPDATE sprints
  SET end_date = (start_date::date + interval '14 days')::date
  WHERE start_date >= end_date;

-- 2. start_date < end_date CHECK 제약 추가
ALTER TABLE sprints
  ADD CONSTRAINT sprints_date_check
    CHECK (start_date < end_date);

-- 3. 프로젝트당 active 스프린트 1개 강제 (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS sprints_active_unique
  ON sprints(project_id)
  WHERE status = 'active' AND deleted_at IS NULL;
