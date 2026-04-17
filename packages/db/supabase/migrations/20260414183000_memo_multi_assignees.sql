-- E-035:S4 — 메모 복수 할당자 지원

-- ============================================================
-- 1. memo_assignees join table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.memo_assignees (
  memo_id     uuid NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  PRIMARY KEY (memo_id, member_id)
);

COMMENT ON TABLE public.memo_assignees IS '메모 할당자 (many-to-many)';

CREATE INDEX idx_memo_assignees_member_id ON public.memo_assignees(member_id);
CREATE INDEX idx_memo_assignees_memo_id ON public.memo_assignees(memo_id);

-- ============================================================
-- 2. 기존 assigned_to 데이터 마이그레이션
-- ============================================================
INSERT INTO public.memo_assignees (memo_id, member_id, assigned_at, assigned_by)
SELECT
  id AS memo_id,
  assigned_to AS member_id,
  created_at AS assigned_at,
  created_by AS assigned_by
FROM public.memos
WHERE assigned_to IS NOT NULL
ON CONFLICT (memo_id, member_id) DO NOTHING;

-- ============================================================
-- 3. 하위호환: assigned_to 컬럼 유지 (deprecated, 읽기 전용)
-- ============================================================
-- assigned_to 컬럼은 제거하지 않음
-- 기존 코드 호환성을 위해 첫 번째 할당자를 반환하는 view 또는 computed column 추가 가능
-- 향후 Phase 3에서 완전히 제거 예정

COMMENT ON COLUMN public.memos.assigned_to IS '[DEPRECATED] 단일 할당자 (하위호환용, memo_assignees 테이블 사용 권장)';

-- ============================================================
-- 4. RLS policies for memo_assignees
-- ============================================================
ALTER TABLE public.memo_assignees ENABLE ROW LEVEL SECURITY;

-- 조직 멤버는 자신이 속한 프로젝트의 memo assignees를 볼 수 있음
CREATE POLICY "memo_assignees_select_org_member"
  ON public.memo_assignees
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memos m
      INNER JOIN public.team_members tm ON tm.project_id = m.project_id
      WHERE m.id = memo_assignees.memo_id
        AND tm.user_id = auth.uid()
    )
  );

-- 조직 멤버는 자신이 속한 프로젝트의 memo assignees를 추가할 수 있음
CREATE POLICY "memo_assignees_insert_org_member"
  ON public.memo_assignees
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memos m
      INNER JOIN public.team_members tm ON tm.project_id = m.project_id
      WHERE m.id = memo_assignees.memo_id
        AND tm.user_id = auth.uid()
    )
  );

-- 조직 멤버는 자신이 속한 프로젝트의 memo assignees를 삭제할 수 있음
CREATE POLICY "memo_assignees_delete_org_member"
  ON public.memo_assignees
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.memos m
      INNER JOIN public.team_members tm ON tm.project_id = m.project_id
      WHERE m.id = memo_assignees.memo_id
        AND tm.user_id = auth.uid()
    )
  );

-- ============================================================
-- 5. Helper functions
-- ============================================================

-- 메모의 모든 할당자 ID 배열 반환
CREATE OR REPLACE FUNCTION public.get_memo_assignee_ids(memo_uuid uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(array_agg(member_id), ARRAY[]::uuid[])
  FROM public.memo_assignees
  WHERE memo_id = memo_uuid;
$$;

COMMENT ON FUNCTION public.get_memo_assignee_ids IS '메모의 모든 할당자 ID 배열 반환';
