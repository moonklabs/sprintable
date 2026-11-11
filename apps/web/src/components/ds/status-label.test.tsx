// UI-3(a9d56577) — ds StatusLabel 회귀가드: 글이 뜻을 싣는다 · 표시 모양이 상태마다 다르다 · 손 필요 · 실패는 아이콘.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
import { StatusLabel, type StatusKind } from './status-label';

const el = () => container.querySelector('[data-slot="ds-status-label"]') as HTMLElement;

describe('ds StatusLabel', () => {
  it('⭐뜻은 항상 글이 싣는다 — 표시(점)는 aria-hidden', async () => {
    await render(<StatusLabel status="online" label="연결됨" />);
    expect(el().textContent).toBe('연결됨');
    expect(el().querySelector('[data-mark]')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('⭐표시 모양이 상태마다 다르다: 연결됨 점 · 끊김 속 빈 점 · 일하는 중 깜빡임 · 손 필요 touch_app · 실패 error', async () => {
    const mark: Record<StatusKind, string> = { online: 'dot', idle: 'dot', offline: 'ring', working: 'pulse', 'needs-hand': 'icon', failed: 'icon' };
    for (const [status, m] of Object.entries(mark)) {
      await render(<StatusLabel status={status as StatusKind} label="글" />);
      if (m === 'icon') expect(el().querySelector('svg'), status).not.toBeNull();
      else expect(el().querySelector(`[data-mark="${m}"]`), status).not.toBeNull();
    }
    await render(<StatusLabel status="needs-hand" label="손 필요 2" />);
    expect(el().querySelector('[data-icon="touch_app"]')).not.toBeNull();
    await render(<StatusLabel status="failed" label="실패" />);
    expect(el().querySelector('[data-icon="error"]')).not.toBeNull();
  });

  it('끊김은 속 빈 점(색 면이 없다) — 연결됨과 색 없이도 구별된다', async () => {
    await render(<StatusLabel status="offline" label="끊김" />);
    const dot = el().querySelector('[data-mark="ring"]') as HTMLElement;
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).toContain('border');
    await render(<StatusLabel status="online" label="연결됨" />);
    expect((el().querySelector('[data-mark="dot"]') as HTMLElement).className).toContain('bg-ds-done');
  });

  it('일하는 중 점은 motion-safe로만 깜빡이고 action 색이다 · 손 필요 글만 호박색', async () => {
    await render(<StatusLabel status="working" label="일하는 중" />);
    const dot = el().querySelector('[data-mark="pulse"]') as HTMLElement;
    expect(dot.className).toContain('motion-safe:animate-ds-pulse');
    expect(dot.className).toContain('bg-ds-action');
    expect(el().className).not.toContain('needs-hand');
    await render(<StatusLabel status="needs-hand" label="손 필요" />);
    expect(el().className).toContain('text-ds-needs-hand');
  });

  it('⭐한 줄 고정 — 좁은 줄에서 글이 접혀 표시가 어긋나지 않는다(nowrap)', async () => {
    await render(<StatusLabel status="needs-hand" label="손 필요 2" />);
    expect(el().className).toContain('whitespace-nowrap');
  });
});
