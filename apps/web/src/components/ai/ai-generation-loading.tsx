import { Sparkles } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * E-SPRINT-LOOP(81b0d17e) — 공용 pro-backed 생성 로딩 컴포넌트. 핸드오프
 * `ai-generation-loading-handoff` §4/§7. 지능 사다리 내러티브(실 파이프라인 순서=진실) +
 * 결과 스켈레톤 + honest 인디터미닛(가짜 % 절대 금지)으로 gemini-3.1-pro-preview(~9초) 대기를
 * 목적성 있게 만든다.
 *
 * ⭐honest 계약(§7, 비협상): steps 배열 길이 = 실 백엔드 phase 수(가짜 phase 발명 금지 — retro
 * 종합=3=실 2 LLM콜, sprint-open L3 초안=1=단일 generate_text 콜). activeIndex는 호출부가
 * heuristic 타이밍으로 advance하되, 응답 도착 전까지는 마지막 스텝에서 절대 넘어가지 않는다
 * (거짓 완료 금지) — 이 컴포넌트 자체는 순수 렌더만 하고 타이머는 소비부 책임.
 *
 * SOUL-LOCK: brand/info/muted 토큰·shimmer·pulse만 사용, destructive(빨강) 0.
 */
export interface AiGenerationLoadingStep {
  label: string;
  desc?: string;
}

export function AiGenerationLoading({
  headline,
  steps,
  activeIndex,
  skeleton,
  transline,
}: {
  /** 브랜드마크 옆에 붙는 서술("가 이번 스프린트를 훑는 중…" 등). */
  headline: string;
  steps: AiGenerationLoadingStep[];
  activeIndex: number;
  skeleton: 'synthesis' | 'draft';
  transline: string;
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          Sprintable AI
        </span>
        <span className="text-[10.5px] font-medium text-muted-foreground">{headline}</span>
      </div>

      <div className="flex flex-col">
        {steps.map((step, i) => {
          const isDone = i < activeIndex;
          const isActive = i === activeIndex;
          const isPending = i > activeIndex;
          return (
            <div key={i} className="relative flex items-start gap-2.5 py-1.5">
              {i < steps.length - 1 ? (
                <span
                  className={cn(
                    'absolute left-[9px] top-[26px] bottom-[-6px] w-px',
                    isDone ? 'bg-primary/40' : 'bg-border',
                  )}
                  aria-hidden
                />
              ) : null}
              <span
                className={cn(
                  'relative z-[1] mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px]',
                  isDone && 'border border-primary/40 bg-primary/15 text-primary',
                  isActive && 'bg-primary text-primary-foreground',
                  isPending && 'border border-border bg-muted text-muted-foreground',
                )}
              >
                {isDone ? '✓' : isActive ? <span className="animate-pulse">✦</span> : i + 1}
                {isActive ? (
                  <span className="absolute -inset-1 rounded-full border border-primary/40 animate-pulse" aria-hidden />
                ) : null}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className={cn('text-xs leading-tight', isPending ? 'text-muted-foreground' : 'font-semibold text-foreground')}>
                  {step.label}
                </p>
                {step.desc ? <p className="text-[10px] leading-snug text-muted-foreground">{step.desc}</p> : null}
                {isActive ? (
                  <div className="relative h-[3px] w-full max-w-[220px] overflow-hidden rounded-full bg-muted">
                    <span className="absolute inset-y-0 left-0 w-[36%] animate-ai-loading-indeterminate rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" aria-hidden />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <GenerationSkeleton variant={skeleton} />

      <p className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground">
        <Sparkles className="size-3 shrink-0 text-primary" aria-hidden />
        {transline}
      </p>
    </div>
  );
}

function GenerationSkeleton({ variant }: { variant: 'synthesis' | 'draft' }) {
  if (variant === 'draft') {
    return (
      <div className="flex flex-col gap-2 border-t border-dashed border-border pt-3">
        <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">곧 나올 초안</p>
        <div className="space-y-2 rounded-lg border border-border bg-card p-2.5">
          <Skeleton variant="text" className="w-[85%]" />
          <Skeleton variant="text" className="w-[55%]" />
          <div className="flex gap-1.5 pt-0.5">
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-11 rounded-full" />
            <Skeleton className="h-4 w-14 rounded-full" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border pt-3">
      <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">곧 나올 종합</p>
      <div className="space-y-2.5 rounded-lg border border-border bg-card p-2.5">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/40" aria-hidden />
            <div className="flex-1 space-y-1.5">
              <Skeleton variant="text" className="w-[90%]" />
              <Skeleton variant="text" className="w-[60%]" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[0, 1].map((i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border bg-card p-2.5">
            <Skeleton variant="text" className="w-[70%]" />
            <Skeleton variant="text" className="h-2 w-[45%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
