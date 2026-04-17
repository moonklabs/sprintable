-- SID:386 — docs folder/document 구분용 명시 플래그

ALTER TABLE public.docs
ADD COLUMN IF NOT EXISTS is_folder boolean NOT NULL DEFAULT false;

-- 기존 트리형 데이터 backfill:
-- 하위 문서가 있는 노드는 폴더로 간주
UPDATE public.docs AS d
SET is_folder = true
WHERE EXISTS (
  SELECT 1
  FROM public.docs AS child
  WHERE child.parent_id = d.id
    AND child.deleted_at IS NULL
);
