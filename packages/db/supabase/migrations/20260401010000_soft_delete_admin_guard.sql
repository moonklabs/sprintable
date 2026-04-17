-- 010: Soft delete admin guard — deleted_at 변경은 admin/owner만 허용

CREATE OR REPLACE FUNCTION public.guard_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role text;
BEGIN
  -- deleted_at가 변경되는 경우에만 체크
  IF (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    SELECT role INTO _role
    FROM public.org_members
    WHERE org_id = NEW.org_id AND user_id = auth.uid();

    IF _role IS NULL OR _role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only org admin/owner can soft-delete records';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 각 테이블에 트리거 적용
CREATE TRIGGER trg_sprints_soft_delete_guard
  BEFORE UPDATE ON public.sprints
  FOR EACH ROW EXECUTE FUNCTION public.guard_soft_delete();

CREATE TRIGGER trg_epics_soft_delete_guard
  BEFORE UPDATE ON public.epics
  FOR EACH ROW EXECUTE FUNCTION public.guard_soft_delete();

CREATE TRIGGER trg_stories_soft_delete_guard
  BEFORE UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.guard_soft_delete();

CREATE TRIGGER trg_tasks_soft_delete_guard
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_soft_delete();
