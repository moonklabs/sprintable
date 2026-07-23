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
import { Alert, AlertDescription } from './alert';

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
});
