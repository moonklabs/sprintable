'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DocContentRenderer } from '@/components/docs/doc-content-renderer';
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

export default function DocViewPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  const t = useTranslations('docs');
  const { projectId } = useDocsLayout();

  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId || !slug) return;
    setLoading(true);
    fetch(`/api/docs?project_id=${projectId}&slug=${slug}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { setDoc(json?.data ?? null); })
      .catch(() => { setDoc(null); })
      .finally(() => { setLoading(false); });
  }, [projectId, slug]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-4 py-3 lg:px-6 lg:py-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="truncate text-xl font-semibold">{doc.title}</h1>
          <Button asChild size="sm" variant="outline">
            <Link href={`/docs/${slug}`}>
              <Edit2 className="mr-1.5 h-3.5 w-3.5" />
              {t('editDoc')}
            </Link>
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-3xl">
          <DocContentRenderer
            content={doc.content}
            contentFormat={doc.content_format ?? 'markdown'}
            codeCopyLabel={t('codeCopy')}
            codeCopiedLabel={t('codeCopied')}
          />
        </div>
      </div>
    </div>
  );
}
