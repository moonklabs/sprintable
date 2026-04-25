-- E-COLLAB-TOOLS S4: docs.tags GIN 인덱스 추가
-- tags 컬럼은 text[] 타입으로 이미 존재 — @> 연산자 검색 최적화

CREATE INDEX IF NOT EXISTS idx_docs_tags_gin
  ON public.docs USING gin(tags);
