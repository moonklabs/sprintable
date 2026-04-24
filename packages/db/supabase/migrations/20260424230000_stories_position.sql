ALTER TABLE public.stories ADD COLUMN IF NOT EXISTS position INTEGER;
UPDATE public.stories SET position = EXTRACT(EPOCH FROM created_at)::INTEGER * 1000 WHERE position IS NULL;
