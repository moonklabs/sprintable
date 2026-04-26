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
  placeholder = '선택하세요',
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
