-- E-PM-ENHANCE S1: epics priority DB CHECK 제약 + null 마이그레이션
-- target_date는 20260424100000에서 이미 추가됨

-- 1. priority null 또는 유효하지 않은 값 → 'medium' 정규화
UPDATE public.epics
  SET priority = 'medium'
  WHERE priority IS NULL OR priority NOT IN ('critical', 'high', 'medium', 'low');

-- 2. priority CHECK 제약 추가
ALTER TABLE public.epics
  ADD CONSTRAINT epics_priority_check
    CHECK (priority IN ('critical', 'high', 'medium', 'low'));
