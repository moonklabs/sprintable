// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IconButton } from './icon-button';

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

describe('ds IconButton', () => {
  it('⭐글자가 없는 단추라 label이 aria-label · title이 된다', async () => {
    await act(async () => { root.render(<IconButton label="닫기" icon="close" />); });
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('닫기');
    expect(b.getAttribute('title')).toBe('닫기');
    expect(b.querySelector('[data-icon="close"]')).not.toBeNull();
  });

  it('크기 28 / 36 · 폰 누름 영역 44', async () => {
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" />); });
    expect(container.querySelector('button')!.className).toContain('size-ds-control-sm');
    expect(container.querySelector('button')!.className).toContain('touch:min-h-ds-touch');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" size="lg" />); });
    expect(container.querySelector('button')!.className).toContain('size-ds-control');
  });

  it('⭐안쪽 아이콘은 단추 크기 표를 따른다 — md · lg(높이 40) = 20 · xl(48) = 24 (story 5048 ④ · 전에는 16 · 18 · 22)', async () => {
    const w = () => container.querySelector('button svg')!.getAttribute('width');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" />); });
    expect(w()).toBe('20');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" size="lg" />); });
    expect(w()).toBe('20');
    await act(async () => { root.render(<IconButton label="더보기" icon="more_horiz" size="xl" />); });
    expect(w()).toBe('24');
  });

  it('⭐상자를 28(`size-ds-tag`)로 줄인 자리는 `iconSize="sm"`으로 16 — 표의 20이 28 칸에 꽉 차지 않게(story 5048 ④ PO dev 실측: 방 머리 «+» 28 안 20)', async () => {
    await act(async () => { root.render(<IconButton label="추가" icon="add" iconSize="sm" className="size-ds-tag" />); });
    expect(container.querySelector('button svg')!.getAttribute('width')).toBe('16');
    await act(async () => { root.render(<IconButton label="추가" icon="add" className="size-ds-tag" />); });
    expect(container.querySelector('button svg')!.getAttribute('width')).toBe('20'); // iconSize를 안 주면 표(md → 20)
  });

  it('⭐방 머리 «+»(`size-ds-tag` 28 칸)는 `iconSize="sm"`을 단다 — 28 칸에 표의 20이 들어가지 않게(소스 고정)', () => {
    const src = readFileSync(join(__dirname, '../chat/room-head.tsx'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('data-testid="room-head-add"') && l.includes('size-ds-tag'));
    expect(line, 'room-head «+» line').toBeTruthy();
    expect(line).toContain('iconSize="sm"');
  });

  it('⭐주 모양 primary: action 면 · 글 on-action · 비활성은 실선 흐린 면 · 이름(label)은 그대로 필수', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" variant="primary" size="xl" />); });
    const b = container.querySelector('button')!;
    expect(b.className).toMatch(/(^|\s)bg-ds-action(\s|$)/);
    expect(b.className).toMatch(/(^|\s)text-ds-on-action(\s|$)/);
    expect(b.className).toContain('disabled:bg-ds-surface-high');
    expect(b.className).not.toContain('border-dashed');
    expect(b.getAttribute('aria-label')).toBe('새 대화');
  });

  it('⭐크기 xl 48(떠 있는 단추) · 폰 누름 44 이상 · 기본 변형은 quiet(면 없음)', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" size="xl" />); });
    const b = container.querySelector('button')!;
    expect(b.className).toContain('size-ds-control-xl');
    expect(b.className).toContain('touch:min-h-ds-touch');
    expect(b.className).not.toMatch(/(^|\s)bg-ds-action(\s|$)/);
    expect(b.querySelector('svg')!.getAttribute('width')).toBe('24'); // 48 큰 아이콘 단추 = lg 24 (story 5048 ④ · 전에는 22)
  });

  it('⭐비활성 primary는 native disabled · aria-disabled(focusableWhenDisabled) 둘 다 활성 색을 잃는다', async () => {
    await act(async () => { root.render(<IconButton label="새 대화" icon="add" variant="primary" disabled />); });
    const cls = container.querySelector('button')!.className;
    for (const p of ['disabled', 'aria-disabled']) {
      expect(cls, p).toContain(`${p}:bg-ds-surface-high`);
      expect(cls, p).toContain(`${p}:border-ds-line`);
      expect(cls, p).toContain(`${p}:brightness-100`);
      expect(cls, p).toContain(`${p}:pointer-events-none`);
    }
  });
});
