// @vitest-environment jsdom
//
// story #3677(FE·대비·確定, 2026-09-07) — InlineSaveIndicator의 status='error' 칩이
// hover:text-destructive/80(resting state보다 대비를 낮추는 방향)을 썼다 — hover는
// underline으로 피드백을 표현하고 색은 그대로(text-destructive, 알파 없음) 두도록
// 교체. page.tsx 전체를 마운트하지 않고 이 하위 컴포넌트만 직접 렌더(export 추가,
// 동작 무변 — page.test.tsx 부재라 이 파일이 유일한 회귀가드).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InlineSaveIndicator } from './page';

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
  vi.restoreAllMocks();
});

const t = ((key: string) => key) as unknown as Parameters<typeof InlineSaveIndicator>[0]['t'];

describe('InlineSaveIndicator — status=error (story #3677 대비 뮤테이션가드)', () => {
  it('hover 클래스가 text-destructive/80이 아니라 underline이다(resting 대비를 낮추지 않음)', async () => {
    await act(async () => {
      root.render(<InlineSaveIndicator status="error" onAction={() => {}} t={t} />);
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    const className = button?.getAttribute('class') ?? '';
    expect(className).toContain('text-destructive');
    expect(className).toContain('hover:underline');
    expect(className).not.toContain('text-destructive/80');
  });
});
