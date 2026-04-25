-- E-COLLAB-TOOLS S1: memos full-text search
-- tsvector 컬럼 + GIN 인덱스 + 자동 갱신 트리거

-- 1. search_vector 컬럼 추가
ALTER TABLE public.memos
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. 기존 데이터 초기화
UPDATE public.memos
SET search_vector = to_tsvector('simple',
  coalesce(title, '') || ' ' || coalesce(content, '')
)
WHERE deleted_at IS NULL;

-- 3. GIN 인덱스
CREATE INDEX IF NOT EXISTS idx_memos_search_vector
  ON public.memos USING gin(search_vector);

-- 4. 자동 갱신 함수
CREATE OR REPLACE FUNCTION public.memos_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '')
  );
  RETURN NEW;
END;
$$;

-- 5. INSERT/UPDATE 트리거
DROP TRIGGER IF EXISTS trg_memos_search_vector ON public.memos;
CREATE TRIGGER trg_memos_search_vector
  BEFORE INSERT OR UPDATE OF title, content
  ON public.memos
  FOR EACH ROW
  EXECUTE FUNCTION public.memos_search_vector_update();
