-- E-PM-ENHANCE S8: sprints.duration + sprints.report_doc_id + docs.doc_type

-- 1. sprints.duration — 스프린트 기간 (일 단위, 기본 14)
ALTER TABLE public.sprints
  ADD COLUMN IF NOT EXISTS duration integer NOT NULL DEFAULT 14;

-- 2. sprints.report_doc_id — 종료 시 자동 생성 report doc 참조
ALTER TABLE public.sprints
  ADD COLUMN IF NOT EXISTS report_doc_id uuid REFERENCES public.docs(id) ON DELETE SET NULL;

-- 3. docs.doc_type — 문서 유형 식별 (page, sprint_report 등)
ALTER TABLE public.docs
  ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'page';
