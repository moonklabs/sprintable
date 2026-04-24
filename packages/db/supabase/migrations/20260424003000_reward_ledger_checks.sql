-- E-SEC-HARDENING:S4 — reward_ledger CHECK 제약 추가
-- 정책(§4, §13 P0-1,2,3) 구현

ALTER TABLE public.reward_ledger
  ADD CONSTRAINT chk_reward_currency
    CHECK (currency IN ('TJSB')),
  ADD CONSTRAINT chk_reward_reference_type
    CHECK (reference_type IS NULL OR reference_type IN ('story', 'sprint', 'epic', 'manual'));
