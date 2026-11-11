'use client';

import { useRef } from 'react';
import { Icon } from '@/components/ds/icon';
import { IconButton } from '@/components/ds/icon-button';
import { Input } from '@/components/ds/input';

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
      {/* story 4892 (UI-9 목록 열) — 찾기 칸 = ds Input + ds Icon · 지우기 = ds IconButton. debounce · API · 핸들러 무변경, 부품만. */}
      <div className="relative">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ds-ink-3" />
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pl-8 pr-9"
        />
        {isSearching && (
          <IconButton
            icon="close"
            label={clearLabel}
            onClick={() => { onClear(); inputRef.current?.focus(); }}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          />
        )}
      </div>
      {isSearching && (
        <p className="mt-1 px-1 text-ds-small text-ds-ink-3">
          {matchCount === 0 ? noResultsLabel : resultCountLabel(matchCount)}
        </p>
      )}
    </div>
  );
}
