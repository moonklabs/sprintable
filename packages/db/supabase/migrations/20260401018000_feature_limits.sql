-- SID:355 — Feature Gating limit 시드
-- Free 티어에 리소스 제한 추가

INSERT INTO public.plan_features (tier_id, feature_key, enabled, limit_value) VALUES
  -- Free 리소스 제한
  ('00000000-0000-0000-0000-000000000a01', 'max_stories', true, 50),
  ('00000000-0000-0000-0000-000000000a01', 'max_docs', true, 10),
  ('00000000-0000-0000-0000-000000000a01', 'max_mockups', true, 5),
  ('00000000-0000-0000-0000-000000000a01', 'byoa_agents', true, 1),
  -- Team 무제한
  ('00000000-0000-0000-0000-000000000a02', 'max_stories', true, NULL),
  ('00000000-0000-0000-0000-000000000a02', 'max_docs', true, NULL),
  ('00000000-0000-0000-0000-000000000a02', 'max_mockups', true, NULL),
  ('00000000-0000-0000-0000-000000000a02', 'byoa_agents', true, NULL),
  -- Pro 무제한
  ('00000000-0000-0000-0000-000000000a03', 'max_stories', true, NULL),
  ('00000000-0000-0000-0000-000000000a03', 'max_docs', true, NULL),
  ('00000000-0000-0000-0000-000000000a03', 'max_mockups', true, NULL),
  ('00000000-0000-0000-0000-000000000a03', 'byoa_agents', true, NULL)
ON CONFLICT (tier_id, feature_key) DO NOTHING;
