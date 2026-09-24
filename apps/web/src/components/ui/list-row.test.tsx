// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ListRow, ListRowMark } from './list-row';

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, root };
}

describe('ListRow', () => {
  it('renders mark·title·subtitle·status·action·menu·children in one row', async () => {
    const { container, root } = await mount(
      <ListRow
        mark={<ListRowMark label="Th" color="#121310" />}
        title="Threads"
        subtitle="@moonklabs · 3일 전 확인"
        status={<span data-testid="status">연결됨</span>}
        action={<button type="button">앱 자격 등록</button>}
        menu={<button type="button" aria-label="더보기">⋯</button>}
      >
        <p data-testid="extra">펼침 콘텐츠</p>
      </ListRow>,
    );
    expect(container.textContent).toContain('Threads');
    expect(container.textContent).toContain('@moonklabs · 3일 전 확인');
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('연결됨');
    expect(container.textContent).toContain('앱 자격 등록');
    expect(container.querySelector('[aria-label="더보기"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="extra"]')?.textContent).toBe('펼침 콘텐츠');
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('subtitle·status·action·menu·children 전부 optional — title 하나만으로도 안 죽는다', async () => {
    const { container, root } = await mount(<ListRow title="Only title" />);
    expect(container.textContent).toBe('Only title');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

// 유나 지적(#4090 리뷰, 2026-09-09 13:13Z) — 이름 있는 프리셋(neutral/blue)은 소비처
// 0이라 걷었다 — color는 항상 hex 인라인 style 하나로.
describe('ListRowMark', () => {
  it('color는 항상 인라인 style(hex)로 그려진다', async () => {
    const { container, root } = await mount(<ListRowMark label="Fb" color="#1877F2" />);
    const mark = container.querySelector('span');
    expect(mark?.textContent).toBe('Fb');
    // jsdom이 hex를 rgb()로 정규화해 돌려준다(#1877F2 = rgb(24,119,242)).
    expect(mark?.getAttribute('style')).toContain('rgb(24, 119, 242)');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});

// [SID:4282 · 유나 결정] 부제 줄바꿈(한국어 띄어쓰기에서만 · 긴 토큰은 어디서든) · 다크에서만 표식 테두리.
describe('ListRow — 부제 줄바꿈 · 다크 표식 테두리(SID:4282)', () => {
  it('부제 <p>에 break-keep과 [overflow-wrap:anywhere]', async () => {
    const { container, root } = await mount(<ListRow title="송윤재" subtitle="개발 · 아직 판정한 가설이 없어요" />);
    const p = Array.from(container.querySelectorAll('p')).find((el) => el.textContent?.includes('아직 판정한'));
    const cls = (p?.className ?? '').split(/\s+/);
    expect(cls).toContain('break-keep');
    expect(cls).toContain('[overflow-wrap:anywhere]');
    await act(async () => { root.unmount(); });
  });
  it('표식은 다크에서만 옅은 테두리(dark:ring-1 dark:ring-border) · 라이트 ring 없음 · 브랜드색 그대로', async () => {
    const { container, root } = await mount(<ListRowMark label="Th" color="#121310" />);
    const mark = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    const cls = mark.className.split(/\s+/);
    expect(cls).toContain('dark:ring-1');
    expect(cls).toContain('dark:ring-border');
    expect(cls.filter((c) => /^ring-/.test(c))).toEqual([]);
    expect(mark.style.backgroundColor).toBe('rgb(18, 19, 16)');
    await act(async () => { root.unmount(); });
  });
});
