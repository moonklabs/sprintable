'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { ExternalLink, X } from 'lucide-react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface DocDetail {
  title: string;
  content: string;
  content_format?: 'markdown' | 'html';
  slug: string;
}

type DocState = DocDetail | null | false;

export default function DocEmbedModal() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const router = useRouter();
  const t = useTranslations('docs');
  const { projectId } = useDashboardContext();
  const overlayRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<DocState>(null);

  useEffect(() => {
    if (!projectId || !slug) return;
    let cancelled = false;
    fetch(`/api/docs?project_id=${projectId}&slug=${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setDoc((json?.data as DocDetail) ?? false); })
      .catch(() => { if (!cancelled) setDoc(false); });
    return () => { cancelled = true; };
  }, [projectId, slug]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') router.back(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [router]);

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) router.back(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="relative flex w-full max-w-3xl max-h-[80vh] flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-6 pt-5 pb-3 border-b border-border">
          <h2 className="truncate text-base font-semibold">
            {doc !== null && doc !== false ? doc.title : '📄'}
          </h2>
          <button
            type="button"
            onClick={() => router.back()}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {doc === null ? (
            <div className="flex items-center justify-center py-8">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            </div>
          ) : doc === false ? (
            <p className="py-4 text-sm text-muted-foreground">{t('notFound')}</p>
          ) : (
            <DocContentRenderer
              content={doc.content}
              contentFormat={doc.content_format ?? 'markdown'}
              codeCopyLabel={t('codeCopy')}
              codeCopiedLabel={t('codeCopied')}
            />
          )}
        </div>

        {/* Footer */}
        {doc !== null && doc !== false && (
          <div className="flex-shrink-0 px-6 py-3 border-t border-border">
            <Link
              href={`/docs/${slug}`}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('editDoc')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
