-- BUG 보강 — get_my_team_member_ids_for_org is_active 필터 누락 수정
-- 20260420093000의 함수 정의에서 AND is_active = true 누락 → 재정의

CREATE OR REPLACE FUNCTION public.get_my_team_member_ids_for_org(_org_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM public.team_members
  WHERE user_id = auth.uid() AND type = 'human' AND org_id = _org_id AND is_active = true;
$$;
