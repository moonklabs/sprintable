-- E-004:S3 — Story 상태 변경/할당 시 assignee 알림 DB trigger

CREATE OR REPLACE FUNCTION public.notify_story_assignee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 신규 할당 (INSERT with assignee)
  IF TG_OP = 'INSERT' AND NEW.assignee_id IS NOT NULL THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      NEW.org_id,
      NEW.assignee_id,
      'task',
      '새 스토리 할당',
      '"' || NEW.title || '" 스토리가 할당되었습니다.',
      'story',
      NEW.id
    );
  END IF;

  -- 할당 변경 (UPDATE에서 assignee_id 변경)
  IF TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT NULL
    AND (OLD.assignee_id IS NULL OR NEW.assignee_id != OLD.assignee_id) THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      NEW.org_id,
      NEW.assignee_id,
      'task',
      '새 스토리 할당',
      '"' || NEW.title || '" 스토리가 할당되었습니다.',
      'story',
      NEW.id
    );
  END IF;

  -- 상태 변경 (UPDATE에서 status 변경, 할당자 있을 때)
  IF TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT NULL
    AND NEW.status IS DISTINCT FROM OLD.status
    AND (OLD.assignee_id IS NOT NULL AND NEW.assignee_id = OLD.assignee_id) THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      NEW.org_id,
      NEW.assignee_id,
      'task',
      '스토리 상태 변경',
      '"' || NEW.title || '" 상태가 ' || OLD.status || ' → ' || NEW.status || '으로 변경되었습니다.',
      'story',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_story_notify_assignee
  AFTER INSERT OR UPDATE ON public.stories
  FOR EACH ROW EXECUTE FUNCTION public.notify_story_assignee();
