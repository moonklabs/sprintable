-- E-PLATFORM-FOUNDATION S9 — memo_assignees 다중 assignee 알림 트리거
--
-- 기존 memos.assigned_to(단일) 기반 트리거를 memo_assignees(다중) 기반으로 이전한다.
-- 기존 트리거는 DROP하여 중복 알림을 방지한다.

-- 1. 기존 memos.assigned_to 기반 트리거 제거 (memo_assignees 트리거로 일원화)
DROP TRIGGER IF EXISTS trg_memo_notify_assignee ON public.memos;
DROP FUNCTION IF EXISTS public.notify_memo_assignee();

-- 2. memo_assignees AFTER INSERT 트리거 — row 단위 알림
CREATE OR REPLACE FUNCTION public.notify_memo_assignees_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id   uuid;
  v_title    text;
  v_content  text;
  v_user_id  uuid;
BEGIN
  SELECT org_id, title, content
    INTO v_org_id, v_title, v_content
    FROM public.memos
   WHERE id = NEW.memo_id;

  SELECT user_id
    INTO v_user_id
    FROM public.team_members
   WHERE id = NEW.member_id;

  IF v_user_id IS NOT NULL AND v_org_id IS NOT NULL THEN
    INSERT INTO public.notifications (org_id, user_id, type, title, body, reference_type, reference_id)
    VALUES (
      v_org_id,
      v_user_id,
      'memo',
      '새 메모',
      '"' || COALESCE(v_title, LEFT(v_content, 50)) || '" 메모가 할당되었습니다.',
      'memo',
      NEW.memo_id
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_memo_assignees_notify
  AFTER INSERT ON public.memo_assignees
  FOR EACH ROW EXECUTE FUNCTION public.notify_memo_assignees_row();
