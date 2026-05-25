'use client';

import { useRef } from 'react';
import { Search, X } from 'lucide-react';

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
    <div className="flex-shrink-0 px-2 pb-1 pt-2">
      <div className="flex items-center gap-1.5 rounded-xl bg-muted/60 px-2.5 py-1.5 ring-1 ring-transparent focus-within:ring-primary/30">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {isSearching && (
          <button
            type="button"
            onClick={() => { onClear(); inputRef.current?.focus(); }}
            aria-label={clearLabel}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {isSearching && (
        <p className="mt-1 px-1 text-[11px] text-muted-foreground">
          {matchCount === 0 ? noResultsLabel : resultCountLabel(matchCount)}
        </p>
      )}
    </div>
  );
}
