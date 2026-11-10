'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { DocsIndex } from './docs-index';
import { fetchWithAuth } from '@/lib/db/client';
import { docUrl } from '@/components/docs/lib/doc-project-url';

// story 4892 (UI-9 §5 #2) — `/docs?id=<doc id>` is the link form that chat cards, the sprint report link and the intent-suggestion card carry
// (proxy.ts sends it on to `/{ws}/{proj}/docs?id=…`). Nothing in the docs area read `id`, so such a link landed on the index. The id is
// resolved the way the chat embed card resolves it (`/api/docs/preview?q=`, slug-or-uuid) and that document is opened. If it does not
// resolve (no access · deleted · network) the index stays — the same page the link led to before.
// Only the characters that change the meaning of a path are escaped: other slugs (Korean ones) are passed as the tree and the editor pass them.
const pathSafe = (slug: string) => slug.replace(/[/?#%]/g, (c) => encodeURIComponent(c));

// story #2955 §6 — 미선택 상태=지식 인덱스 렌더(라우트 추가 불요). 옛 `DocsEmptyView`
// ("문서를 선택하세요" 죽은 화면)를 대체한다.
export default function DocsPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const docId = searchParams.get('id')?.trim() || null;
  const wsSlug = typeof params.ws === 'string' ? params.ws : null;
  const projSlug = typeof params.proj === 'string' ? params.proj : null;

  useEffect(() => {
    if (!docId || !wsSlug || !projSlug) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/docs/preview?q=${encodeURIComponent(docId)}`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { slug?: string | null; orgSlug?: string | null; projectSlug?: string | null } };
        const d = json.data;
        const slug = d?.slug?.trim();
        if (cancelled || !d || !slug) return;
        router.replace(docUrl(d.orgSlug || wsSlug, d.projectSlug || projSlug, pathSafe(slug)));
      } catch {
        // stays on the index
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, wsSlug, projSlug, router]);

  return <DocsIndex />;
}
