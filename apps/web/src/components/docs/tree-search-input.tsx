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
  placeholder: string;
  clearLabel: string;
}

export function TreeSearchInput({
  value,
  onChange,
  onClear,
  isSearching,
  placeholder,
  clearLabel,
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
      {/* story 4892 (UI-9 문서 트리) — 개수 줄 «N개 문서 일치» · «검색 결과가 없어요»는 이 칸 아래에도, 결과 목록 맨 위(DocSearchResults)에도 있어 한 화면에 두 번 보였다(결과를 기다리는 동안에도
          «없음»이 먼저 떴다). 결과 쪽이 답을 아는 자리라 여기 것을 걷는다 — 한 번만. */}
    </div>
  );
}
