'use client';

import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface OperatorDropdownSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
}

export function OperatorDropdownSelect({
  value,
  onValueChange,
  options,
  // components/ui/*는 도메인 ns가 없다 — 로케일 문구가 필요한 호출부가 명시로 넘긴다
  // (story #3930, 실 소비처 13곳 전수 확認: value가 항상 options 중 하나와 매치돼 이
  // 기본값 자체는 렌더된 적이 없다 — 렌더 회귀 0).
  placeholder = 'Select',
  disabled = false,
  className,
  align = 'start',
}: OperatorDropdownSelectProps) {
  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type="button"
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50',
              !selectedOption && 'text-muted-foreground',
              className,
            )}
          >
            <span className="truncate">{displayLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align={align}>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            disabled={option.disabled}
            onClick={() => !option.disabled && onValueChange(option.value)}
          >
            <span className="flex-1 truncate">{option.label}</span>
            {option.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
