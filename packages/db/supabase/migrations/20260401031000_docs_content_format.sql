-- SID:385 — docs content_format + 데이터 정리

-- AC1: content_format 컬럼 추가
ALTER TABLE public.docs ADD COLUMN IF NOT EXISTS content_format text NOT NULL DEFAULT 'markdown'
  CHECK (content_format IN ('markdown', 'html'));

-- AC2: HTML 콘텐츠 감지 → content_format=html 설정
-- <로 시작하거나 </로 포함된 content는 HTML로 간주
UPDATE public.docs SET content_format = 'html'
  WHERE content LIKE '<%' OR content LIKE '%</%';

-- AC4: undefined/null content → 빈 문자열로 정리
UPDATE public.docs SET content = '' WHERE content IS NULL;
