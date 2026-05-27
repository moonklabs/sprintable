import type { HTMLAttributes, SVGProps } from 'react';
import { cn } from '@/lib/utils';

const MARK_PATHS = [
  "M562.6 388.1 c-1.6 -1.8 -1.7 -3.6 -1.2 -17.7 0.3 -8.7 0.8 -15.9 1.1 -16.2 0.2 -0.3 1.1 0.1 2 0.8 1.2 1 1.5 4.2 1.5 18.1 0 9.3 -0.4 16.9 -0.8 16.9 -0.5 0 -1.7 -0.9 -2.6 -1.9z",
  "M458 373.4 c0 -9.8 0.4 -16.3 1.2 -17.7 0.6 -1.2 5.6 -8.5 11.2 -16.2 30.8 -42.8 40 -55 41.6 -55.3 2 -0.3 5.5 4.3 4 5.3 -1.4 0.8 -1.4 53.5 0 53.5 0.6 0 1 1.7 1 3.7 0 2.9 -0.3 3.4 -1.2 2.5 -2 -2 -4.9 -1.4 -8.8 2.1 -2.1 1.7 -6.3 5.2 -9.5 7.7 -3.2 2.5 -8.1 6.5 -11 9 -2.9 2.5 -8.3 7 -12 10 -3.7 3 -8.1 6.7 -10 8.3 -6.2 5.2 -6.5 4.6 -6.5 -12.9z",
  "M540.5 369.8 c-12.6 -10.4 -24.2 -20.2 -25.8 -21.8 l-2.7 -2.9 0.2 -29.3 c0.3 -24.3 0.5 -29.3 1.7 -29.3 1.5 0 52.2 69.5 51.5 70.6 -0.2 0.4 -0.5 7 -0.6 14.6 -0.1 7.6 -0.4 14.5 -0.7 15.4 -0.5 1.2 -6.1 -2.9 -23.6 -17.3z",
  "M438 446.2 l0 -19.7 35.4 -29 c27.2 -22.3 36.2 -29.1 38.6 -29.3 l3.2 -0.3 -0.3 17 c-0.2 12.3 0 17.4 0.9 18.3 1.4 1.4 1.6 6.8 0.3 6.8 -0.6 0 -1.3 -0.4 -1.6 -1 -1.2 -2 -3.7 -0.9 -9.8 4.2 -3.5 2.9 -10.5 8.7 -15.6 12.8 -5.2 4.1 -11.7 9.5 -14.6 12 -2.9 2.5 -7.8 6.5 -10.9 9 -3.2 2.5 -9.7 7.7 -14.4 11.7 -4.8 4 -9.3 7.2 -9.9 7.3 -1 0 -1.3 -4.6 -1.3 -19.8z",
  "M578 460.6 c-3.6 -2.9 -19.3 -15.8 -35 -28.6 -15.7 -12.8 -29.3 -24.4 -30.2 -25.8 -1.5 -2.2 -1.6 -4.9 -1.3 -20 0.3 -9.6 0.7 -17.7 1 -18.1 1 -0.9 3.9 1.3 39.3 30.2 l34.2 28.1 0 19.8 c0 10.9 -0.3 19.8 -0.7 19.8 -0.5 0 -3.7 -2.4 -7.3 -5.4z",
  "M510.8 568.9 c-1.7 -2.8 -22.1 -41.4 -26.7 -50.6 l-3.1 -6.2 4.8 -4.2 c2.6 -2.3 6.3 -5.2 8.2 -6.4 1.9 -1.2 4.4 -3.2 5.5 -4.5 3.3 -3.6 11.1 -9 13.2 -9 1.1 0 2.8 0.8 3.7 1.9 1.5 1.6 1.5 1.9 0.1 2.4 -1.3 0.6 -1.5 5.2 -1.5 37.4 -0.1 28.8 -0.4 37.3 -1.4 39.2 l-1.3 2.4 -1.5 -2.4z",
  "M438.1 506.8 l0 -20.3 19.1 -15.5 c10.5 -8.5 26.5 -21.7 35.7 -29.2 10.5 -8.7 17.4 -13.8 18.9 -13.8 2.8 0 7.2 2.8 7.2 4.6 0 0.8 -0.9 1.4 -2 1.4 -1.9 0 -2 0.7 -2 15 0 9.3 0.4 15 1 15 0.6 0 1 1.6 1 3.7 0 3.4 -0.1 3.5 -1.8 2 -2.7 -2.5 -3.7 -2.2 -10.5 3.5 -3.5 2.9 -13.2 10.9 -21.6 17.8 -8.4 6.9 -19.6 16.1 -24.8 20.5 -11.4 9.5 -19 15.5 -19.7 15.5 -0.3 0 -0.6 -9.1 -0.5 -20.2z",
  "M511.9 570.3 c-0.2 -0.4 -0.3 -18.7 -0.1 -40.6 0.2 -34.1 0.5 -39.9 1.7 -40.3 1 -0.4 6 3.1 13.6 9.2 6.6 5.5 13 10.6 14.1 11.5 2 1.5 1.9 1.7 -3.5 12.5 -11.2 22.1 -25.5 48.6 -25.8 47.7z",
  "M551 499 c-19 -15.5 -35.5 -29.3 -36.8 -30.6 -2.1 -2.2 -2.2 -3 -2.2 -20.7 0 -15.3 0.3 -18.6 1.5 -19 0.8 -0.4 1.7 -0.1 2.1 0.5 0.5 0.7 0.2 0.8 -0.6 0.3 -0.9 -0.5 -1.1 -0.4 -0.6 0.4 0.4 0.6 1.2 0.8 1.8 0.5 0.5 -0.3 2.4 0.7 4.1 2.3 1.8 1.7 17.1 14.4 34 28.3 17 13.9 31.1 25.8 31.3 26.4 0.2 0.6 0.3 9.8 0.2 20.5 l-0.3 19.3 -34.5 -28.2z",
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
      viewBox="430 278 164 300"
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
      <g fill="currentColor">
        {MARK_PATHS.map((d, index) => (
          <path key={index} d={d} />
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
