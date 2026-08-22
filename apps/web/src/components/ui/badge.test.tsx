// @vitest-environment jsdom
//
// story #2937(유나 P0-02 chip 전수 감사, 2026-08-22) — Badge chip variant가 다른 tint 변형
// (destructive/success/info/warning, #2420 v3 규칙)과 동일하게 text-foreground를 쓰는지
// 고정. text-muted-foreground(ink-3)로 되돌아가면 소비처 ~30(loops/retro/standup/gates/
// trust/recruiter/agents/cage) 전체가 라이트 테마에서 다시 AA 미달로 회귀한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Badge } from './badge';

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

describe('Badge — chip variant 대비(story #2937)', () => {
  it('chip variant는 text-foreground를 쓴다(text-muted-foreground 아님)', async () => {
    await act(async () => {
      root.render(<Badge variant="chip">member</Badge>);
    });
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    expect(el.className).toContain('text-foreground');
    expect(el.className).not.toContain('text-muted-foreground');
  });

  it('다른 tint 변형(success/info/warning/destructive)과 동일한 text-foreground 규칙 — chip만 예외였던 상태로 되돌아가지 않는다', async () => {
    await act(async () => {
      root.render(
        <div>
          <Badge variant="success">a</Badge>
          <Badge variant="info">b</Badge>
          <Badge variant="warning">c</Badge>
          <Badge variant="destructive">d</Badge>
          <Badge variant="chip">e</Badge>
        </div>,
      );
    });
    const badges = [...container.querySelectorAll('[data-slot="badge"]')] as HTMLElement[];
    expect(badges).toHaveLength(5);
    for (const el of badges) {
      expect(el.className).toContain('text-foreground');
    }
  });
});
