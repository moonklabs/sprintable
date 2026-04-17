-- SID:543 — docs tag metadata support

ALTER TABLE public.docs
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];

UPDATE public.docs
  SET tags = '{}'::text[]
  WHERE tags IS NULL;
