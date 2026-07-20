import type { HTMLAttributes, SVGProps } from 'react';
import { cn } from '@/lib/utils';

// doc web-logo-rocket-swap-spec §1/§2 — 로켓-A 3-stroke(셰브론+상승 트레일 2단).
// 리브랜딩 전 9-fill 앰버 마크(brand-rocket-mark-canonical 확定 이전)에서 스왑.
const MARK_STROKES = [
  { d: 'M26 61 L50 25 L74 61', strokeWidth: 13.5, opacity: 1 },
  { d: 'M34 71 L50 50 L66 71', strokeWidth: 10, opacity: 0.6 },
  { d: 'M40 80 L50 69 L60 80', strokeWidth: 7, opacity: 0.38 },
] as const;

type SprintableLogoVariant = 'stacked' | 'horizontal' | 'mark';

type SprintableLogoProps = {
  variant?: SprintableLogoVariant;
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  title?: string;
};

type LogoSvgProps = Omit<SVGProps<SVGSVGElement>, 'title'> & {
  title?: string;
};

function isDecorative(props: SVGProps<SVGSVGElement>) {
  return props['aria-hidden'] === true || props['aria-hidden'] === 'true';
}

export function SprintableLogo({
  variant = 'stacked',
  className,
  markClassName,
  wordmarkClassName,
  title = 'Sprintable',
}: SprintableLogoProps) {
  if (variant === 'mark') {
    return (
      <SprintableMark
        className={cn('h-10 w-auto shrink-0', className, markClassName)}
        title={title}
      />
    );
  }

  if (variant === 'horizontal') {
    return (
      <span
        role="img"
        aria-label={title}
        className={cn('inline-flex items-center gap-4', className)}
      >
        <SprintableMark
          aria-hidden="true"
          className={cn('h-8 w-auto shrink-0', markClassName)}
          title={title}
        />
        <SprintableTypeWordmark
          aria-hidden="true"
          className={cn('shrink-0 text-[0.98rem] font-black tracking-[0.12em]', wordmarkClassName)}
          title={title}
        />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={title}
      className={cn('inline-flex flex-col items-center gap-2', className)}
    >
      <SprintableMark
        aria-hidden="true"
        className={cn('h-10 w-auto shrink-0', markClassName)}
        title={title}
      />
      <SprintableTypeWordmark
        aria-hidden="true"
        className={cn('h-5 w-auto shrink-0', wordmarkClassName)}
        title={title}
      />
    </span>
  );
}

export function SprintableMark({
  className,
  title = 'Sprintable mark',
  ...props
}: LogoSvgProps) {
  const decorative = isDecorative(props);

  return (
    <svg
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      focusable="false"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      className={className}
      {...props}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {MARK_STROKES.map(({ d, strokeWidth, opacity }, index) => (
          <path key={index} d={d} strokeWidth={strokeWidth} opacity={opacity} />
        ))}
      </g>
    </svg>
  );
}

function SprintableTypeWordmark({
  className,
  title = 'Sprintable wordmark',
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'title'> & { title?: string }) {
  const decorative = props['aria-hidden'] === true || props['aria-hidden'] === 'true';

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      className={cn('font-heading leading-none text-current', className)}
      {...props}
    >
      Sprintable
    </span>
  );
}
