import type { HTMLAttributes, SVGProps } from 'react';
import { cn } from '@/lib/utils';

// story #2529(유나 핸드오프 brand-mark-v2-handoff-2529 §2/§6-1) — v1(3단 stroke 모노)에서
// v2(2단 fill 듀오톤)로 정본 교체. Figma 519:606(라이트)/521:2001(다크) 실벡터 그대로.
// viewBox는 마크 자연 경계(v1의 0 0 100 100 아님).
const MARK_PATHS = {
  top: 'M357.307 290.387L186.863 4.33447C183.418 -1.43989 175.049 -1.44976 171.604 4.33447L0.874031 290.387C-0.527499 292.608 -0.221531 295.5 1.63402 297.366C3.86462 299.616 7.50662 299.577 9.68788 297.297L169.196 130.63C174.664 124.915 183.793 124.944 189.222 130.699L347.506 298.254C349.687 300.564 353.349 300.613 355.589 298.353L356.557 297.376C358.402 295.51 358.718 292.618 357.317 290.407L357.307 290.387Z',
  bottom: 'M183.195 177.032C180.945 174.575 177.076 174.594 174.855 177.072L79.1067 289.39C76.9551 291.917 77.0933 295.678 79.4325 298.037C81.7322 300.357 85.4235 300.564 87.9699 298.521L170.7 245.285C175.615 241.544 182.405 241.524 187.35 245.225L270.564 297.869C273.12 299.893 276.782 299.666 279.072 297.356L279.634 296.784C281.993 294.405 282.111 290.614 279.91 288.088L183.195 177.022V177.032Z',
} as const;

type SprintableLogoVariant = 'stacked' | 'horizontal' | 'mark';

// tone='auto'(기본) — 라이트=듀오톤(인디고+시안) / 다크=모노(흰+회), globals.css 토큰이 전환.
// tone='mono' — 고정-다크 표면(항상 어두운 배경, 예: 랜딩 헤더·푸터— apps/web 밖 별도 레포)
// 전용. 듀오톤은 currentColor 상속이 불가(2색 fill)라 마크 색은 이 prop으로만 결정된다.
type SprintableMarkTone = 'auto' | 'mono';

type SprintableLogoProps = {
  variant?: SprintableLogoVariant;
  tone?: SprintableMarkTone;
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  title?: string;
};

type LogoSvgProps = Omit<SVGProps<SVGSVGElement>, 'title'> & {
  title?: string;
  tone?: SprintableMarkTone;
};

function isDecorative(props: SVGProps<SVGSVGElement>) {
  return props['aria-hidden'] === true || props['aria-hidden'] === 'true';
}

export function SprintableLogo({
  variant = 'stacked',
  tone = 'auto',
  className,
  markClassName,
  wordmarkClassName,
  title = 'Sprintable',
}: SprintableLogoProps) {
  if (variant === 'mark') {
    return (
      <SprintableMark
        tone={tone}
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
          tone={tone}
          className={cn('h-8 w-auto shrink-0', markClassName)}
          title={title}
        />
        <SprintableTypeWordmark
          aria-hidden="true"
          className={cn('shrink-0 text-[0.98rem]', wordmarkClassName)}
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
        tone={tone}
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
  tone = 'auto',
  ...props
}: LogoSvgProps) {
  const decorative = isDecorative(props);
  // mono은 고정 HEX(랜딩 등 항상-다크 표면 전용), auto는 globals.css 토큰(:root 듀오톤 /
  // .dark 모노)을 그대로 참조 — 테마 전환에 컴포넌트가 반응할 필요가 없다(값이 뒤집힌다).
  const primaryFill = tone === 'mono' ? '#FFFFFF' : 'var(--brand-mark-primary)';
  const accentFill = tone === 'mono' ? '#ADADAD' : 'var(--brand-mark-accent)';

  return (
    <svg
      viewBox="0 0 358.188 300.018"
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
      <path d={MARK_PATHS.top} fill={primaryFill} />
      <path d={MARK_PATHS.bottom} fill={accentFill} />
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
      // story #2529(핸드오프 §4/§6-1): Inter font-black(900)+tracking-[0.12em] → Rajdhani
      // 600(font-wordmark, globals.css @font-face). 자간은 Rajdhani 실측 스펙이 안 와서
      // 임의 유지하지 않음(v1의 Inter 전용 값이라 그대로 옮기면 추측) — 유나 시안대조 필요.
      // 이 컴포넌트 하나에만 적용되므로 v1 stacked variant의 자간 누락 결함도 같이 해소된다.
      className={cn('font-wordmark leading-none text-current', className)}
      {...props}
    >
      Sprintable
    </span>
  );
}
