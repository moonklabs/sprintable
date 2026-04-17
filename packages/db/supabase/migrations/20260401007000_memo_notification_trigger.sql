-- E-005:S1 — 메모 생성 시 assigned_to에게 알림 DB trigger

CREATE OR REPLACE FUNCTION public.notify_memo_assignee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 신규 메모에 assigned_to가 있으면 알림
  IF TG_OP = 'INSERT' AND NEW.assigned_to IS NOT NULL THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      NEW.org_id,
      NEW.assigned_to,
      'memo',
      '새 메모',
      '"' || COALESCE(NEW.title, LEFT(NEW.content, 50)) || '" 메모가 할당되었습니다.',
      'memo',
      NEW.id
    );
  END IF;

  -- UPDATE에서 assigned_to 변경
  IF TG_OP = 'UPDATE' AND NEW.assigned_to IS NOT NULL
    AND (OLD.assigned_to IS NULL OR NEW.assigned_to != OLD.assigned_to) THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      NEW.org_id,
      NEW.assigned_to,
      'memo',
      '메모 할당',
      '"' || COALESCE(NEW.title, LEFT(NEW.content, 50)) || '" 메모가 할당되었습니다.',
      'memo',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_memo_notify_assignee
  AFTER INSERT OR UPDATE ON public.memos
  FOR EACH ROW EXECUTE FUNCTION public.notify_memo_assignee();
