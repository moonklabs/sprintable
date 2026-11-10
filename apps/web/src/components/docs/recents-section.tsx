'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { DOC_STATUS_TONE, toDocStatusFilter } from './lib/doc-status-tone';

interface Doc {
  id: string;
  title: string;
  slug: string;
  icon?: string | null;
  // story #2963 §3 — 레일 v2 proof 상태 도트 소스.
  status?: string;
}

// story #2963 §3 — proof 상태 도트(6px). 색은 도트에만(§4 대비 규율).
function StatusDot({ status }: { status: string | undefined }) {
  const tone = DOC_STATUS_TONE[toDocStatusFilter(status)];
  return <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />;
}

interface RecentsSectionProps {
  recentSlugs: string[];
  docs: Doc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  label: string;
  emptyLabel: string;
}

// story 4892 (UI-9 목록 열, 첫 조각) — «최근»이 ds 부품을 입는다: 머리글 = SectionHeader(접기 · 건수), 줄 = ListRow(줄 전체가 단추).
// 동작은 그대로: 접기 `aria-expanded`, 고르면 `onSelect(slug)`, 열린 문서만 `aria-current="page"`, 상태 점, 빈 문구.
export function RecentsSection({ recentSlugs, docs, selectedSlug, onSelect, label, emptyLabel }: RecentsSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  const recentDocs = recentSlugs
    .map((slug) => docs.find((d) => d.slug === slug))
    .filter((d): d is Doc => d !== undefined);

  return (
    <div>
      <SectionHeader
        title={label}
        count={recentDocs.length > 0 ? <span className="font-mono text-ds-mono-md tabular-nums text-ds-ink-3">{recentDocs.length}</span> : undefined}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />
      {!collapsed && (
        recentDocs.length === 0 ? (
          <p className="px-4 py-2 text-ds-small italic text-ds-ink-3">{emptyLabel}</p>
        ) : (
          <ul>
            {recentDocs.map((doc) => (
              <li key={doc.id}>
                <ListRow asChild selected={selectedSlug === doc.slug}>
                  <button
                    type="button"
                    onClick={() => onSelect(doc.slug)}
                    aria-current={selectedSlug === doc.slug ? 'page' : undefined}
                    className="w-full"
                  >
                    <StatusDot status={doc.status} />
                    {doc.icon ? (
                      <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
                    ) : (
                      <Icon name="description" size={16} className="text-ds-ink-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-ds-body font-semibold text-ds-ink">{doc.title}</span>
                  </button>
                </ListRow>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
