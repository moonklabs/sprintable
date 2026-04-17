-- SID:376 — meetings 녹음 URL 컬럼 + Storage bucket/policy
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS recording_url text;

-- recordings bucket (idempotent via IF NOT EXISTS handled by Supabase dashboard;
-- storage.buckets insert is the migration-safe equivalent)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'recordings',
  'recordings',
  true,
  52428800, -- 50 MB
  ARRAY['audio/webm', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'audio/ogg']
)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for recordings bucket
CREATE POLICY "recordings_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'recordings');

CREATE POLICY "recordings_insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'recordings'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "recordings_update" ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'recordings'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "recordings_delete" ON storage.objects FOR DELETE
  USING (
    bucket_id = 'recordings'
    AND auth.role() = 'authenticated'
  );
