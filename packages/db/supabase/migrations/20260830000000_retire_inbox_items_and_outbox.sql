-- story #1969(2026-08-30, PO 최종 판정 + 카디르 QA 3라운드 — 페드루 정정) — inbox_items/
-- inbox_outbox(Operator Cockpit Phase A) 완전 은퇴, 자체호스팅(self-hosted) 채널 집행.
--
-- 이 디렉터리(packages/db/supabase/migrations)는 옛 파일을 편집하지 않는다(이미 적용된
-- 히스토리 마이그 규율, backend/alembic의 0002/0114와 동형) — 대신 옛 파일들이 매
-- 재시작마다 재실행되는 idempotent replay 모델(scripts/run-migrations.sh, 파일명 순
-- 정렬)에 맞춰 이 신규 파일을 뒤에 붙인다. 20260426170000_inbox_items.sql의
-- `CREATE TABLE IF NOT EXISTS`가 먼저 돌아 테이블을 (재)생성한 뒤 이 파일이 곧바로
-- 지운다 — 매 재시작 최종 상태는 항상 "부재"로 수렴한다.
--
-- SaaS(backend/alembic, 0293/0294)와 같은 안전 문법: 데이터를 지어내지 않는다. 재고가
-- 있으면(진짜 self-hosted 사용자가 실제로 썼을 가능성) drop 대신 archived 이름으로
-- 보존만 한다. to_regclass 가드로 반복 replay에도 안전(이미 지워졌으면 스킵).
--
-- 의존 객체 선삭제(CASCADE 금지, 명시 DROP — 혹시 모를 다른 의존이 있으면 조용히
-- 삼키지 않고 크게 실패해야 한다). 호출부는 레포 전체 0건(rpc 호출 grep 0).
-- ⚠️ disposable PG 실물 재현으로 발견한 것 2건(카디르 지적엔 없던 자리 — 자체 검증):
--   ① inbox_outbox.inbox_item_id에 실 FK(REFERENCES inbox_items(id))가 있어(20260426170200_
--     inbox_outbox.sql) DROP TABLE inbox_items를 inbox_outbox보다 먼저 하면 FK 의존으로
--     거부된다 — 순서를 outbox(자식)→items(부모)로 뒤집어야 한다(backend/alembic 0293/0294는
--     이 FK가 baseline schema.sql에 없어 순서 무관했지만, 이 자체호스팅 스키마는 실 FK가
--     있어 순서가 의미를 가진다).
--   ② 각 파일이 등록한 트리거 함수(validate_inbox_item_from_agent·
--     touch_inbox_outbox_updated_at)는 RPC 3+4종과 별개로, 테이블 drop 시 트리거 자체는
--     같이 지워지지만 함수 객체는 안 지워져 고아로 남는다 — 같이 정리한다.

-- 트리거가 함수에 의존하므로(CASCADE 없이) 함수보다 먼저 트리거 자체를 명시 제거.
DROP TRIGGER IF EXISTS trg_inbox_outbox_touch_updated_at ON public.inbox_outbox;
DROP TRIGGER IF EXISTS trg_inbox_items_validate_agent ON public.inbox_items;

DROP FUNCTION IF EXISTS public.claim_pending_outbox;
DROP FUNCTION IF EXISTS public.mark_outbox_delivered;
DROP FUNCTION IF EXISTS public.mark_outbox_failed;
DROP FUNCTION IF EXISTS public.mark_outbox_dead;
DROP FUNCTION IF EXISTS public.touch_inbox_outbox_updated_at;
DROP FUNCTION IF EXISTS public.resolve_inbox_item;
DROP FUNCTION IF EXISTS public.dismiss_inbox_item;
DROP FUNCTION IF EXISTS public.reassign_inbox_item;
DROP FUNCTION IF EXISTS public.validate_inbox_item_from_agent;

DO $$
DECLARE
  _count bigint;
BEGIN
  -- 자식(outbox) 먼저 — inbox_items에 FK로 묶여 있다.
  IF to_regclass('public.inbox_outbox') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.inbox_outbox' INTO _count;
    IF _count = 0 THEN
      DROP TABLE public.inbox_outbox;
    ELSIF to_regclass('public.inbox_outbox_archived_1969') IS NULL THEN
      ALTER TABLE public.inbox_outbox RENAME TO inbox_outbox_archived_1969;
    END IF;
  END IF;

  IF to_regclass('public.inbox_items') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.inbox_items' INTO _count;
    IF _count = 0 THEN
      DROP TABLE public.inbox_items;
    ELSIF to_regclass('public.inbox_items_archived_1969') IS NULL THEN
      ALTER TABLE public.inbox_items RENAME TO inbox_items_archived_1969;
    END IF;
  END IF;
END $$;
