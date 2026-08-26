// @vitest-environment jsdom
//
// story #2149 — 공용 <Alert>가 variant와 무관하게 항상 role="alert"(assertive)로 고정돼
// 있어, variant="success"/"info" 성공·안내 메시지까지 사용자의 스크린리더 낭독을 끊고
// 들어갔다(#2096이 정한 "에러=assertive/성공-안내=polite" 관례 위반). #2148 판별 중
// 발견 — Alert 컴포넌트가 최초 생성(2026-05-26)될 때부터 그랬고, #2096 관례는 그로부터
// 약 2개월 뒤(2026-07-22)에 생겨 소급 반영되지 않았던 순수 누락.
//
// 설계 제약(PO 지시) — 실패 방향은 안전한 쪽이어야 한다: variant를 못 읽거나 새
// variant가 추가돼 매핑에 없으면 assertive로 떨어져야 한다(에러가 조용해지는 것이
// 성공이 시끄러운 것보다 나쁘다). 즉 success/info만 명시적으로 polite, 그 외 전부
// assertive다 — 이 테스트는 그 allowlist 방향이 실제로 지켜지는지 고정한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Alert, AlertDescription, AlertTitle } from './alert';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('Alert 접근성 (story #2149)', () => {
  // AC1 — variant별 role/aria-live 고정. success/info만 polite, 나머지(default/warning/
  // destructive)는 전부 assertive. 새 variant를 추가하는 사람이 이 매핑을 안 건드리면
  // 여기가 깨져서 잡는다.
  it.each([
    ['default', 'alert', 'assertive'],
    ['warning', 'alert', 'assertive'],
    ['destructive', 'alert', 'assertive'],
    [undefined, 'alert', 'assertive'],
    ['success', 'status', 'polite'],
    ['info', 'status', 'polite'],
  ] as const)('variant=%s → role=%s, aria-live=%s', async (variant, expectedRole, expectedLive) => {
    await act(async () => {
      root.render(<Alert variant={variant}><AlertDescription>메시지</AlertDescription></Alert>);
    });
    const el = container.querySelector(`[role="${expectedRole}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe(expectedLive);
    expect(el?.getAttribute('aria-atomic')).toBe('true');
  });

  it('매핑에 없는 미지의 variant는 안전한 방향(assertive)으로 떨어진다', async () => {
    // 아직 alertVariants에 정의되지 않은 variant를 억지로 통과시켜, "새 variant 추가 시
    // 매핑을 깜빡해도 조용해지지 않는다"는 설계 제약을 직접 증명한다.
    const unmappedVariant = 'brand-new-variant' as unknown as React.ComponentProps<typeof Alert>['variant'];
    await act(async () => {
      root.render(<Alert variant={unmappedVariant}><AlertDescription>메시지</AlertDescription></Alert>);
    });
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe('assertive');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('호출부가 명시적으로 role/aria-live를 넘기면 그 값이 우선한다(기존 doc-sync-banner 오버라이드 패턴 보존)', async () => {
    await act(async () => {
      root.render(
        <Alert variant="success" role="alert" aria-live="assertive">
          <AlertDescription>강제 오버라이드</AlertDescription>
        </Alert>,
      );
    });
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe('assertive');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('destructive와 status가 동시에 잡히지 않는다(이중 낭독 방지)', async () => {
    await act(async () => {
      root.render(<Alert variant="destructive"><AlertDescription>에러</AlertDescription></Alert>);
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  // 유나 지적(error-display 폴리시) — 공백 없는 초장문(토큰·URL 등)이 grid 1fr 트랙을
  // 넘어 넘쳐흘렀다. AlertTitle/AlertDescription 둘 다 anywhere로 어디서나 끊을 여지를 준다.
  it('AlertTitle/AlertDescription이 overflow-wrap:anywhere를 갖는다(초장문 overflow 회귀가드)', async () => {
    await act(async () => {
      root.render(
        <Alert variant="destructive">
          <AlertTitle>제목</AlertTitle>
          <AlertDescription>본문</AlertDescription>
        </Alert>,
      );
    });
    const title = container.querySelector('p');
    const description = container.querySelectorAll('p')[1];
    expect(title?.className).toContain('[overflow-wrap:anywhere]');
    expect(description?.className).toContain('[overflow-wrap:anywhere]');
  });
});

// story #2513 — 유나 design 스펙(ds-alert-variant-contrast-unify-2513): 라이트 테마
// success/destructive/info의 「tint 배경 위 색-글자」가 AA(4.5) 미달이었다(3.99~4.18
// FAIL, warning만 text-foreground라 18.40 PASS). 글자를 text-foreground로 통일하되
// variant 색 정체성은 border-*-border/bg-*-tint로 유지한다.
describe('Alert variant 라이트 대비 통일 (story #2513)', () => {
  it.each(['success', 'destructive', 'info', 'warning'] as const)(
    'variant=%s — 글자는 text-foreground로 통일된다(색-글자 AA 미달 재발 방지)',
    async (variant) => {
      await act(async () => {
        root.render(<Alert variant={variant}><AlertDescription>메시지</AlertDescription></Alert>);
      });
      const el = container.firstElementChild;
      expect(el?.className).toContain('text-foreground');
      expect(el?.className).not.toContain('text-success');
      expect(el?.className).not.toContain('text-destructive');
      expect(el?.className).not.toContain('text-info');
    },
  );

  // story #2969 §2 PR-2(doc proofline-system-layer-2969) — 색 variant(success/warning/
  // destructive/info)는 좌측 2px 상태 액센트를 갖는다. default(중립)는 축이 없어 미적용.
  it.each(['success', 'warning', 'destructive', 'info'] as const)(
    'variant=%s — 좌측 2px 상태 액센트(border-l-2)를 갖는다',
    async (variant) => {
      await act(async () => {
        root.render(<Alert variant={variant}><AlertDescription>메시지</AlertDescription></Alert>);
      });
      expect(container.firstElementChild?.className).toContain('border-l-2');
    },
  );

  it('default(중립)는 좌측 액센트가 없다(축이 없음)', async () => {
    await act(async () => {
      root.render(<Alert><AlertDescription>메시지</AlertDescription></Alert>);
    });
    expect(container.firstElementChild?.className).not.toContain('border-l-2');
  });

  // 글자만 foreground로 통일됐을 뿐 variant 구분(색 정체성) 자체는 border/tint로 남아야
  // 한다 — 넷이 서로 다른 border-*-border/bg-*-tint를 갖는지 직접 대조.
  it('variant별 색 정체성(border·tint)은 서로 다르게 유지된다(글자 통일이 구분을 지우지 않는다)', async () => {
    const variants = ['success', 'destructive', 'info', 'warning'] as const;
    const classNames: string[] = [];
    for (const variant of variants) {
      await act(async () => {
        root.render(<Alert variant={variant}><AlertDescription>메시지</AlertDescription></Alert>);
      });
      classNames.push(container.firstElementChild?.className ?? '');
    }
    const borderTintOnly = classNames.map((c) =>
      c.split(' ').filter((tok) => tok.includes('-border') || tok.includes('-tint')).sort().join(' '),
    );
    expect(new Set(borderTintOnly).size).toBe(variants.length);
  });
});
