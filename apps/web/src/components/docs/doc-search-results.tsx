'use client';

import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

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
        <mark key={i} className="rounded bg-highlight-search-bg px-0.5 text-foreground">
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
    return <p className="px-3 py-4 text-xs text-muted-foreground">{loadingLabel}</p>;
  }

  if (!loading && results.length === 0) {
    return <p className="px-3 py-4 text-xs text-muted-foreground">{noResultsLabel}</p>;
  }

  return (
    <div className="px-2 py-1">
      <p className="px-1 py-1 text-[11px] text-muted-foreground">{resultCountLabel(results.length)}</p>
      <ul className="space-y-0.5">
        {results.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              onClick={() => onSelect(doc.slug)}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                selectedSlug === doc.slug
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground/88 hover:bg-muted hover:text-foreground',
              )}
            >
              <span className="flex items-center gap-2 text-sm">
                {doc.icon ? (
                  <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{doc.title}</span>
              </span>
              {/* story #2167 AC2 — slug로 찾은 결과가 어떤 slug인지 화면에 보여야 한다. */}
              <span className="truncate pl-5 font-mono text-[10px] text-muted-foreground">{doc.slug}</span>
              {doc.snippet ? (
                <span className="truncate pl-5 text-[11px] text-muted-foreground">
                  {highlightSnippet(doc.snippet)}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {results.length >= cap && cappedLabel ? (
        <p className="px-2 py-1.5 text-[10px] text-muted-foreground">{cappedLabel}</p>
      ) : null}
    </div>
  );
}
