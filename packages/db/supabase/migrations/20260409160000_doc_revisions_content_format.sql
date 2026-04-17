-- SID:542 — doc revision format preservation for preview/restore parity

ALTER TABLE public.doc_revisions
  ADD COLUMN IF NOT EXISTS content_format text;

-- Existing revision rows predate content_format, so infer a safe default.
UPDATE public.doc_revisions
SET content_format = CASE
  WHEN content LIKE '<%' OR content LIKE '%</%' THEN 'html'
  ELSE 'markdown'
END
WHERE content_format IS NULL;

ALTER TABLE public.doc_revisions
  ALTER COLUMN content_format SET DEFAULT 'markdown';

ALTER TABLE public.doc_revisions
  ALTER COLUMN content_format SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'doc_revisions_content_format_check'
  ) THEN
    ALTER TABLE public.doc_revisions
      ADD CONSTRAINT doc_revisions_content_format_check
      CHECK (content_format IN ('markdown', 'html'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.auto_save_doc_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_format IS DISTINCT FROM OLD.content_format THEN
    INSERT INTO public.doc_revisions (doc_id, content, content_format, created_by)
    VALUES (
      NEW.id,
      OLD.content,
      COALESCE(OLD.content_format, 'markdown'),
      NEW.created_by
    );
  END IF;
  RETURN NEW;
END;
$$;
