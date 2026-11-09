'use client';

import { useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';

interface TreeSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  isSearching: boolean;
  matchCount: number;
  placeholder: string;
  clearLabel: string;
  noResultsLabel: string;
  resultCountLabel: (n: number) => string;
}

export function TreeSearchInput({
  value,
  onChange,
  onClear,
  isSearching,
  matchCount,
  placeholder,
  clearLabel,
  noResultsLabel,
  resultCountLabel,
}: TreeSearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex-shrink-0 px-3 pb-2 pt-1">
      {/* story #2963 §2 — 에디토리얼 검색 필드(hairline border·proof-bg). debounce·API·핸들러
          무변경, 형태만(shadcn rounded-xl+muted bg → hairline+proof-bg). */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-auto bg-card py-1.5 pl-8 pr-8 dark:bg-card"
        />
        {isSearching && (
          <button
            type="button"
            onClick={() => { onClear(); inputRef.current?.focus(); }}
            aria-label={clearLabel}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {isSearching && (
        <p className="mt-1 px-1 text-editorial-meta text-muted-foreground">
          {matchCount === 0 ? noResultsLabel : resultCountLabel(matchCount)}
        </p>
      )}
    </div>
  );
}
