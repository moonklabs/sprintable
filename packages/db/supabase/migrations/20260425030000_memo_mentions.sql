-- E-COLLAB-TOOLS S2: memo_mentions 테이블 신설

CREATE TABLE IF NOT EXISTS public.memo_mentions (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  memo_id           uuid        NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  mentioned_user_id uuid        NOT NULL,
  created_at        timestamptz DEFAULT now() NOT NULL,
  UNIQUE (memo_id, mentioned_user_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_mentions_memo_id
  ON public.memo_mentions(memo_id);

CREATE INDEX IF NOT EXISTS idx_memo_mentions_user_id
  ON public.memo_mentions(mentioned_user_id);

ALTER TABLE public.memo_mentions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memo_mentions_select" ON public.memo_mentions FOR SELECT
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
        AND deleted_at IS NULL
    )
  );

CREATE POLICY "memo_mentions_insert" ON public.memo_mentions FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
        AND deleted_at IS NULL
    )
  );
