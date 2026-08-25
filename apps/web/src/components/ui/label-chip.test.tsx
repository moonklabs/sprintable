// @vitest-environment jsdom
//
// story #7d7634ee(P0·카디르 QA REQUEST_CHANGES 동류 확장) — badge.tsx와 동형으로 label-chip.tsx도
// A급 뿌리(2파일 소비처, story #2969 §1.4 "proof-cut-xs 소 컷" 목록에 badge.tsx와 함께 등재됐던
// 자리)인데 이 파일 자체엔 회귀가드가 아예 없었다(신설). badge.tsx 가드와 동형 구조.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LabelChip } from './label-chip';

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

describe('LabelChip — story #7d7634ee proof-surface 뿌리 회귀가드', () => {
  it('proof-surface + proof-surface-press를 쓰고, 폐지된 proof-cut/proof-cut-xs는 남아있지 않다', async () => {
    await act(async () => {
      root.render(<LabelChip label={{ id: '1', name: '스펙', color: '#3E7DC2' }} />);
    });
    const el = container.querySelector('span') as HTMLElement;
    const classes = el.className.split(' ');
    expect(classes).toContain('proof-surface');
    expect(classes).toContain('proof-surface-press');
    expect(classes).not.toContain('proof-cut');
    expect(classes).not.toContain('proof-cut-xs');
  });
});
