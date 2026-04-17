-- S544 [E-023:S13] memo collaboration parity — attachments, doc links, read receipts

-- ============================================================
-- 1. Storage bucket for memo images
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'memo-attachments',
  'memo-attachments',
  true,
  10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "memo_attachments_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'memo-attachments');

CREATE POLICY "memo_attachments_insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'memo-attachments'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "memo_attachments_update" ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'memo-attachments'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "memo_attachments_delete" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'memo-attachments'
    AND auth.role() = 'authenticated'
  );

-- ============================================================
-- 2. memo_doc_links
-- ============================================================
CREATE TABLE IF NOT EXISTS public.memo_doc_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memo_id     uuid NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  doc_id      uuid NOT NULL REFERENCES public.docs(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memo_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_doc_links_memo_id ON public.memo_doc_links(memo_id);
CREATE INDEX IF NOT EXISTS idx_memo_doc_links_doc_id ON public.memo_doc_links(doc_id);

ALTER TABLE public.memo_doc_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memo_doc_links_select" ON public.memo_doc_links FOR SELECT
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND doc_id IN (
      SELECT d.id
      FROM public.docs d
      JOIN public.memos m ON m.project_id = d.project_id
      WHERE m.id = memo_id
        AND m.org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY "memo_doc_links_insert" ON public.memo_doc_links FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND doc_id IN (
      SELECT d.id
      FROM public.docs d
      JOIN public.memos m ON m.project_id = d.project_id
      WHERE m.id = memo_id
        AND m.org_id IN (SELECT public.get_user_org_ids())
    )
    AND created_by IN (
      SELECT public.get_my_team_member_id_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

CREATE POLICY "memo_doc_links_update" ON public.memo_doc_links FOR UPDATE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY "memo_doc_links_delete" ON public.memo_doc_links FOR DELETE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
  );

-- ============================================================
-- 3. memo_reads
-- ============================================================
CREATE TABLE IF NOT EXISTS public.memo_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memo_id         uuid NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  team_member_id  uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (memo_id, team_member_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_reads_memo_id ON public.memo_reads(memo_id);
CREATE INDEX IF NOT EXISTS idx_memo_reads_team_member_id ON public.memo_reads(team_member_id);

ALTER TABLE public.memo_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "memo_reads_select" ON public.memo_reads FOR SELECT
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
  );

CREATE POLICY "memo_reads_insert" ON public.memo_reads FOR INSERT
  WITH CHECK (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND team_member_id IN (
      SELECT public.get_my_team_member_id_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

CREATE POLICY "memo_reads_update" ON public.memo_reads FOR UPDATE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_org_ids())
    )
    AND team_member_id IN (
      SELECT public.get_my_team_member_id_for_org(m.org_id)
      FROM public.memos m WHERE m.id = memo_id
    )
  );

CREATE POLICY "memo_reads_delete" ON public.memo_reads FOR DELETE
  USING (
    memo_id IN (
      SELECT id FROM public.memos
      WHERE org_id IN (SELECT public.get_user_admin_org_ids())
    )
  );

-- ============================================================
-- 4. Realtime publication
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.memo_doc_links;
ALTER PUBLICATION supabase_realtime ADD TABLE public.memo_reads;
