-- E-PLATFORM-SECURE S8: 레거시 과금 테이블 정리 + grace_period 추가

-- 1. 미사용 레거시 과금 테이블 DROP
--    price_tier_map: Paddle/Toss PG price 매핑 (Polar로 전환됨, OSS 미참조)
--    plan_offering_snapshots: grandfathering 스냅샷 (OSS 미참조)
DROP TABLE IF EXISTS public.price_tier_map CASCADE;
DROP TABLE IF EXISTS public.plan_offering_snapshots CASCADE;

-- NOTE: subscriptions, plan_tiers, plan_features 테이블은
--       SaaS overlay에서 관리 중(checkFeatureLimit 구현체 경유)이므로 유지.
--       OSS 직접 참조는 meetings/transcribe route에서 제거됨 (AC2).

-- 2. org_subscriptions에 grace_until 컬럼 추가
--    Polar 취소 webhook 수신 시 grace_until = now() + interval '30 days' 설정
ALTER TABLE public.org_subscriptions
  ADD COLUMN IF NOT EXISTS grace_until timestamptz;
