-- E-DATA-INTEGRITY S3: stories 테이블 스키마 강화
-- priority CHECK + story_points 피보나치 CHECK + acceptance_criteria 컬럼

-- 1. priority 무효값 정리 → 'medium'으로 교정
UPDATE stories
  SET priority = 'medium'
  WHERE priority NOT IN ('critical', 'high', 'medium', 'low');

-- 2. priority CHECK 제약 추가
ALTER TABLE stories
  ADD CONSTRAINT stories_priority_check
    CHECK (priority IN ('critical', 'high', 'medium', 'low'));

-- 3. story_points 비표준 값 → 가장 가까운 피보나치로 마이그레이션
UPDATE stories SET story_points =
  CASE
    WHEN story_points <= 1  THEN 1
    WHEN story_points <= 2  THEN 2
    WHEN story_points <= 3  THEN 3
    WHEN story_points <= 6  THEN 5
    WHEN story_points <= 10 THEN 8
    WHEN story_points <= 17 THEN 13
    ELSE 21
  END
WHERE story_points IS NOT NULL
  AND story_points NOT IN (1, 2, 3, 5, 8, 13, 21);

-- 4. story_points CHECK 제약 추가 (NULL 또는 피보나치만 허용)
ALTER TABLE stories
  ADD CONSTRAINT stories_sp_check
    CHECK (story_points IS NULL OR story_points IN (1, 2, 3, 5, 8, 13, 21));

-- 5. acceptance_criteria 컬럼 추가 (nullable)
ALTER TABLE stories ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT;
