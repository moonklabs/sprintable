'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { DocToc } from '@/components/docs/doc-toc';
import { extractDocHeadings } from '@/components/docs/doc-heading-utils';
import { Button } from '@/components/ui/button';
import { Edit2 } from 'lucide-react';
import { useDocsLayout } from '../../docs-context';

interface DocDetail {
  id: string;
  title: string;
  slug: string;
  content: string;
  content_format?: 'markdown' | 'html';
}

// null = 로딩 중, false = not found, DocDetail = 로드 완료
type DocState = DocDetail | null | false;

export default function DocViewPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const t = useTranslations('docs');
  const { projectId } = useDocsLayout();

  const [doc, setDoc] = useState<DocState>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const scrollToHeading = useCallback((id: string) => {
    contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (!projectId || !slug) return;
    let cancelled = false;
    fetch(`/api/docs?project_id=${projectId}&slug=${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setDoc((json?.data as DocDetail) ?? false); })
      .catch(() => { if (!cancelled) setDoc(false); });
    return () => { cancelled = true; };
  }, [projectId, slug]);

  if (doc === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  if (doc === false) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-3xl">
          {/* Inline title (Notion style — same layout as editor) */}
          <div className="mb-6 flex items-start justify-between gap-4">
            <h1 className="flex-1 break-words text-4xl font-bold leading-tight">{doc.title}</h1>
            <div className="mt-1 flex flex-shrink-0 items-center gap-2">
              <DocToc
                headings={extractDocHeadings(doc.content, doc.content_format ?? 'markdown')}
                onHeadingClick={scrollToHeading}
              />
              <Button asChild size="sm" variant="ghost">
                <Link href={`/docs/${slug}`}>
                  <Edit2 className="mr-1.5 h-3.5 w-3.5" />
                  {t('editDoc')}
                </Link>
              </Button>
            </div>
          </div>
          <DocContentRenderer
            content={doc.content}
            contentFormat={doc.content_format ?? 'markdown'}
            contentRef={contentRef}
            codeCopyLabel={t('codeCopy')}
            codeCopiedLabel={t('codeCopied')}
          />
        </div>
      </div>
    </div>
  );
}
