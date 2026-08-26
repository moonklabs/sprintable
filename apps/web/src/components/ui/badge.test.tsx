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

// story #7d7634ee(P0·카디르 QA REQUEST_CHANGES) — badge.tsx 뿌리 base className이 이
// PR의 최대 가치(76파일/223콜사이트 자동 캐스케이드)인데, 그 자리를 직접 고정하는 가드가
// 없었다(구버전 proof-cut으로 되돌리는 mutation에도 전체 스위트 0건 실패 — 카디르 실측
// 적발). 다른 파일의 렌더 결과로 간접 확인하는 게 아니라 badge.tsx 자신의 className을
// 직접 대조한다.
describe('Badge — story #7d7634ee proof-surface 뿌리 회귀가드(76파일/223콜사이트 캐스케이드)', () => {
  it('proof-surface + proof-surface-press를 쓰고, 폐지된 proof-cut/proof-cut-xs는 남아있지 않다', async () => {
    await act(async () => {
      root.render(<Badge>기본</Badge>);
    });
    const el = container.querySelector('[data-slot="badge"]') as HTMLElement;
    const classes = el.className.split(' ');
    expect(classes).toContain('proof-surface');
    expect(classes).toContain('proof-surface-press');
    expect(classes).not.toContain('proof-cut');
    expect(classes).not.toContain('proof-cut-xs');
  });
});
