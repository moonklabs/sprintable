-- 008: Fix FK CASCADE → SET NULL for memos/memo_replies created_by
-- 팀멤버 삭제 시 메모/답글이 전량 삭제되는 문제 수정

-- 1. memos.created_by: nullable + ON DELETE SET NULL
ALTER TABLE public.memos ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.memos
  DROP CONSTRAINT IF EXISTS memos_created_by_fkey;

ALTER TABLE public.memos
  ADD CONSTRAINT memos_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.team_members(id) ON DELETE SET NULL;

-- 2. memo_replies.created_by: nullable + ON DELETE SET NULL
ALTER TABLE public.memo_replies ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.memo_replies
  DROP CONSTRAINT IF EXISTS memo_replies_created_by_fkey;

ALTER TABLE public.memo_replies
  ADD CONSTRAINT memo_replies_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.team_members(id) ON DELETE SET NULL;
