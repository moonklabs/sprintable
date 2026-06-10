'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
import { DocToc } from '@/components/docs/doc-toc';
import { extractDocHeadings } from '@/components/docs/doc-heading-utils';

/** Public response is intentionally minimal — title/content only, no metadata. */
interface PublicDoc {
  title: string;
  content: string;
  content_format?: 'markdown' | 'html';
}

// null = loading, false = invalid/revoked/expired (404/410), PublicDoc = valid
type ViewState = PublicDoc | null | false;

export default function SharedDocPage() {
  const params = useParams();
  const token = typeof params.token === 'string' ? params.token : '';
  const t = useTranslations('docs');
  const ts = useTranslations('share');

  const [doc, setDoc] = useState<ViewState>(token ? null : false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const scrollToHeading = useCallback((id: string) => {
    contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // Invalid/revoked/expired tokens return 404/410 → render the generic invalid state
    // (the document's existence is never disclosed).
    fetch(`/api/public/docs/${token}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setDoc((json?.data as PublicDoc) ?? false); })
      .catch(() => { if (!cancelled) setDoc(false); });
    return () => { cancelled = true; };
  }, [token]);

  if (doc === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (doc === false) {
    return (
      <div className="flex h-64 items-center justify-center px-4">
        <p className="text-sm font-medium text-foreground">{ts('publicLinkInvalid')}</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-8 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <h1 className="flex-1 break-words text-4xl font-bold leading-tight max-md:text-2xl">{doc.title}</h1>
          <div className="mt-1 flex-shrink-0">
            <DocToc
              headings={extractDocHeadings(doc.content, doc.content_format ?? 'markdown')}
              onHeadingClick={scrollToHeading}
            />
          </div>
        </div>
        <DocContentRenderer
          content={doc.content}
          contentFormat={doc.content_format ?? 'markdown'}
          contentRef={contentRef}
          codeCopyLabel={t('codeCopy')}
          codeCopiedLabel={t('codeCopied')}
          publicMode
        />
      </div>
    </div>
  );
}
