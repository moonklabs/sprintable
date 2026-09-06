'use client';

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { getEntityHref } from '@/components/chat/embed-card';
import type { BacklinkItem } from '@/components/shared/entity-backlinks-section';

// story #3560(제작 작업대 컨셉 카드, 페드루 PO 確定 2026-09-06 — 화면 자리 ④ 채택: 새
// 화면 0) — 컨셉 카드=Doc(§3560 FE 조각 確定 ①-c). 「이것을 가리키는 것들」
// (EntityBacklinksSection)과 같은 API(`/api/stories/{id}/backlinks`)를 그대로 재사용
// 하되(새 엔드포인트 0), `source_type==='doc'`만 걸러 별 블록으로 보인다 — 검증
// 시트(EvidenceSection)와 자리를 안 섞는다. 참조 doc이 있을 때만 그린다(§5-2 "없는
// 길을 그리지 않는다"의 반대축 — 여기서는 "없음"을 문구로 말하지 않고 블록 자체를
// 안 그리는 쪽, 유나 §17-24 확定).
export function ConceptCardSection({ workItemId }: { workItemId: string }) {
  const t = useTranslations('board');
  const [items, setItems] = useState<BacklinkItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/stories/${workItemId}/backlinks`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: BacklinkItem[] }>) : null))
      .then((json) => { if (!cancelled) setItems(json?.data ?? []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [workItemId]);

  const docItems = (items ?? []).filter((item) => item.source_type === 'doc' && item.doc);
  if (docItems.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-4 py-3" data-testid="concept-card-section">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('conceptCardTitle')}</p>
      <ul className="flex flex-col gap-1.5">
        {docItems.map((item) => {
          const href = getEntityHref('doc', item.doc!.id);
          return (
            <li key={item.id} className="flex items-start gap-2 text-xs text-foreground">
              <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {href ? (
                <a href={href} className="[overflow-wrap:anywhere] hover:underline">{item.doc!.title}</a>
              ) : (
                <span className="[overflow-wrap:anywhere]">{item.doc!.title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
