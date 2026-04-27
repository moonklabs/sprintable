ALTER TABLE public.stories ADD COLUMN IF NOT EXISTS position BIGINT;
UPDATE public.stories SET position = EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 WHERE position IS NULL;
