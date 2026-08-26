import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border p-3 text-sm [&>svg]:mt-0.5 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted/40 text-foreground',
        // story #2513 — 글자는 text-foreground로 통일(라이트 테마 AA 미달 fix, warning과
        // 동형). variant 정체성은 border-*-border·아이콘·bg-*-tint로만 표현한다.
        // story #2969 §2 PR-2(doc proofline-system-layer-2969) — 좌측 2px 상태 액센트
        // 추가(border-l-2, 기존 border-*-border 색 그대로 두껍게만). default(중립)는 축이
        // 없어 미적용, 색 variant 전부 대칭 적용(doc "정보/경고 색"은 대표 예시로 읽음 —
        // success/destructive만 빼면 형제간 비일관).
        success:
          'border-success-border border-l-2 bg-success-tint text-foreground',
        warning:
          'border-warning-border border-l-2 bg-warning-tint text-foreground',
        destructive:
          'border-destructive-border border-l-2 bg-destructive-tint text-foreground',
        info:
          'border-info-border border-l-2 bg-info-tint text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

// story #2149: role/aria-live는 variant에서 유도한다. 오직 success/info만 명시적으로
// polite — 그 외(default/warning/destructive, 그리고 매핑에 없는 미지의 variant)는
// 전부 assertive로 떨어진다. 에러가 조용해지는 것이 성공이 시끄러운 것보다 나쁘다.
const POLITE_ALERT_VARIANTS = new Set(['success', 'info']);

function getAlertRole(variant?: string | null): 'alert' | 'status' {
  return variant && POLITE_ALERT_VARIANTS.has(variant) ? 'status' : 'alert';
}

function getAlertAriaLive(variant?: string | null): 'assertive' | 'polite' {
  return variant && POLITE_ALERT_VARIANTS.has(variant) ? 'polite' : 'assertive';
}

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, role, 'aria-live': ariaLive, 'aria-atomic': ariaAtomic, ...props }, ref) => (
  <div
    ref={ref}
    role={role ?? getAlertRole(variant)}
    aria-live={ariaLive ?? getAlertAriaLive(variant)}
    aria-atomic={ariaAtomic ?? 'true'}
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = 'Alert';

// 유나 지적(error-display 폴리시) — 공백 없는 초장문(토큰·URL·해시 등)이 grid의
// 1fr 트랙을 넘어 넘쳐흘렀다. grid/flex 아이템은 기본 min-width:auto라 트랙 크기
// 지정만으론 안 막히고, 텍스트에 실제로 줄바꿈 여지를 줘야 한다 — break-word 대신
// anywhere(공백 없어도 어디서나 끊음, min-content 계산에도 안전)를 쓴다.
const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('col-start-2 font-medium leading-5 [overflow-wrap:anywhere]', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('col-start-2 text-xs leading-relaxed opacity-90 [overflow-wrap:anywhere]', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
