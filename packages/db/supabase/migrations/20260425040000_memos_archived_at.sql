-- E-COLLAB-TOOLS S3: memos.archived_at 컬럼 추가
ALTER TABLE public.memos
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_memos_archived_at
  ON public.memos(archived_at)
  WHERE archived_at IS NOT NULL;
