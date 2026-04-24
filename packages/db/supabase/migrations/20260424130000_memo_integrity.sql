-- E-DATA-INTEGRITY S6: memos 테이블 정합성 강화

-- 1. 기존 CHECK 위반 memo_type 정리 → 'memo'로 교정
UPDATE memos
  SET memo_type = 'memo'
  WHERE memo_type NOT IN (
    'memo', 'task', 'checklist', 'decision', 'request', 'handoff',
    'feedback', 'announcement', 'general', 'system_workflow_update'
  );

-- 2. memo_type CHECK 제약 추가
ALTER TABLE memos
  ADD CONSTRAINT memos_type_check
    CHECK (memo_type IN (
      'memo', 'task', 'checklist', 'decision', 'request', 'handoff',
      'feedback', 'announcement', 'general', 'system_workflow_update'
    ));

-- 3. memos SELECT RLS deleted_at IS NULL — 이미 20260401020000_rls_soft_delete.sql에서 적용됨
--    (확인 완료, 추가 migration 불필요)
