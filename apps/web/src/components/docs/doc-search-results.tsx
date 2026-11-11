'use client';

import { Icon } from '@/components/ds/icon';
import { ListRow } from '@/components/ds/list-row';

// story #2167(2026-07-25, 까심): "이 문서가 있는가"의 답은 서버가 낸다(전문검색, slug 포함)
// — 로컬 트리는 사본이라 아직 로드 안 된 문서는 못 찾는다(PO 판정 (나)). 검색어가 있을 때는
// DocTree(브라우징 전용)를 그대로 두고 이 플랫 리스트로 완전히 갈아끼운다.
export interface DocSearchResult {
  id: string;
  title: string;
  slug: string;
  icon: string | null;
  snippet?: string | null;
}

interface DocSearchResultsProps {
  results: DocSearchResult[];
  loading: boolean;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  loadingLabel: string;
  noResultsLabel: string;
  resultCountLabel: (n: number) => string;
  cappedLabel?: string;
  cap: number;
}

function highlightSnippet(snippet: string) {
  // BE ts_headline이 <b>로 감싸 보낸다(doc.py search_full_text) — 안전한 고정 태그만 렌더.
  const parts = snippet.split(/(<b>.*?<\/b>)/g);
  return parts.map((part, i) => {
    const match = /^<b>(.*)<\/b>$/.exec(part);
    if (match) {
      return (
        <mark key={i} className="rounded-ds-control bg-ds-action-soft px-0.5 text-ds-ink">
          {match[1]}
        </mark>
      );
    }
    return part;
  });
}

export function DocSearchResults({
  results,
  loading,
  selectedSlug,
  onSelect,
  loadingLabel,
  noResultsLabel,
  resultCountLabel,
  cappedLabel,
  cap,
}: DocSearchResultsProps) {
  if (loading && results.length === 0) {
    return <p className="px-4 py-4 text-ds-small text-ds-ink-3">{loadingLabel}</p>;
  }

  if (!loading && results.length === 0) {
    return <p className="px-4 py-4 text-ds-small text-ds-ink-3">{noResultsLabel}</p>;
  }

  return (
    <div className="py-1">
      <p className="px-4 py-1 text-ds-small text-ds-ink-3">{resultCountLabel(results.length)}</p>
      <ul>
        {results.map((doc) => (
          <li key={doc.id}>
            {/* story 4892 (UI-9 목록 열) — 결과 줄 = ds ListRow(줄 전체가 단추). 제목 · slug(mono) · 맞은 글귀(강조)는 그대로, 열린 문서만 aria-current="page". */}
            <ListRow asChild selected={selectedSlug === doc.slug}>
              <button
                type="button"
                onClick={() => onSelect(doc.slug)}
                aria-current={selectedSlug === doc.slug ? 'page' : undefined}
                className="w-full items-start py-2"
              >
                {doc.icon ? (
                  <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
                ) : (
                  <Icon name="description" size={16} className="mt-0.5 text-ds-ink-3" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-ds-body font-semibold text-ds-ink">{doc.title}</span>
                  {/* story #2167 AC2 — slug로 찾은 결과가 어떤 slug인지 화면에 보여야 한다. */}
                  <span className="truncate font-mono text-ds-mono-md text-ds-ink-3">{doc.slug}</span>
                  {doc.snippet ? (
                    <span className="truncate text-ds-small text-ds-ink-3">{highlightSnippet(doc.snippet)}</span>
                  ) : null}
                </span>
              </button>
            </ListRow>
          </li>
        ))}
      </ul>
      {results.length >= cap && cappedLabel ? (
        <p className="px-4 py-1.5 text-ds-small text-ds-ink-3">{cappedLabel}</p>
      ) : null}
    </div>
  );
}
