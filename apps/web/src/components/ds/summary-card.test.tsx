// @vitest-environment jsdom
// UI-3(a9d56577) — ds SummaryCard 회귀가드: 제목(section 이름) + 이름/값 목록(dl) · 넓은 화면 카드 / 좁은 화면 칩 줄 · 빈 값 «—» + 읽히는 이유 · 항목 없음 글.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SummaryCard } from './summary-card';

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
const card = () => container.querySelector('[data-slot="ds-summary-card"]') as HTMLElement;
const rows = () => Array.from(container.querySelectorAll('[data-slot="ds-summary-item"]')) as HTMLElement[];
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

const ITEMS = [
  { id: 'role', label: '직무', value: '프런트엔드' },
  { id: 'scope', label: '범위', value: '조직 전체' },
  { id: 'runtime', label: '실행 환경', value: null },
];

describe('ds SummaryCard', () => {
  it('⭐section은 제목으로 이름을 얻고(aria-labelledby) 항목은 dl의 dt/dd 쌍이다', async () => {
    await render(<SummaryCard emptyLabel="비었어요" title="지금까지 고른 것" items={ITEMS} />);
    expect(card().tagName).toBe('SECTION');
    const h = card().querySelector('h2')!;
    expect(card().getAttribute('aria-labelledby')).toBe(h.id);
    expect(h.textContent).toBe('지금까지 고른 것');
    expect(card().querySelector('dl')).not.toBeNull();
    expect(rows().length).toBe(3);
    expect(rows()[0]!.querySelector('dt')!.textContent).toBe('직무');
    expect(rows()[0]!.querySelector('dd')!.textContent).toBe('프런트엔드');
  });

  it('⭐넓은 화면(lg)은 카드: 면 surface · 헤어라인 · 모서리 · 안 여백 — 좁은 화면엔 껍데기가 없다', async () => {
    await render(<SummaryCard emptyLabel="비었어요" title="요약" items={ITEMS} />);
    for (const c of ['lg:rounded-ds-control', 'lg:border', 'lg:border-ds-line', 'lg:bg-ds-surface', 'lg:p-3']) expect(has(card(), c), c).toBe(true);
    expect(has(card(), 'border')).toBe(false);
    expect(has(card(), 'bg-ds-surface')).toBe(false);
  });

  it('⭐좁은 화면은 칩 줄: 제목은 눈에서만 숨고(sr-only) · 항목은 둥근 칩이 되며 «이름 값»이 글로 함께 있다', async () => {
    await render(<SummaryCard emptyLabel="비었어요" title="요약" items={ITEMS} />);
    expect(has(card().querySelector('h2') as Element, 'max-lg:sr-only')).toBe(true);
    const dl = card().querySelector('dl')!;
    for (const c of ['max-lg:flex-row', 'max-lg:flex-wrap']) expect(has(dl, c), c).toBe(true);
    for (const c of ['max-lg:inline-flex', 'max-lg:rounded-ds-pill', 'max-lg:border', 'max-lg:border-ds-line', 'max-lg:bg-ds-surface-sunk']) expect(has(rows()[0]!, c), c).toBe(true);
    expect(rows()[1]!.textContent).toBe('범위조직 전체');
  });

  it('⭐빈 값(null · 빈 글 · false)은 «—»로 그려지고 이유는 보이지 않는 글로 읽힌다 — 0은 값이다', async () => {
    await render(<SummaryCard title="요약" emptyLabel="아직 안 골랐어요" items={[...ITEMS, { id: 'e', label: '빈 글', value: '' }, { id: 'f', label: '거짓', value: false }, { id: 'z', label: '개수', value: 0 }]} />);
    const dd = (i: number) => rows()[i]!.querySelector('dd')!;
    for (const i of [2, 3, 4]) {
      expect(dd(i).querySelector('[aria-hidden="true"]')!.textContent).toBe('—');
      expect(dd(i).querySelector('.sr-only')!.textContent).toBe('아직 안 골랐어요');
    }
    expect(dd(5).textContent).toBe('0');
    expect(dd(5).querySelector('.sr-only')).toBeNull();
  });

  it('빈 값의 이유 글(emptyLabel)은 필수다 — 타입이 막고, 값이 있는 항목엔 이유 글이 없다', async () => {
    // @ts-expect-error emptyLabel 없이는 쓸 수 없다(빈 값이 스크린리더에 읽히지 않는 꼴을 타입이 막는다)
    await render(<SummaryCard title="요약" items={ITEMS} />);
    expect(rows()[0]!.querySelector('.sr-only')).toBeNull();
  });

  it('항목이 하나도 없으면 emptyText(없으면 아무것도 안 그림) — dl은 없다', async () => {
    await render(<SummaryCard emptyLabel="비었어요" title="요약" items={[]} emptyText="고른 것이 없어요" />);
    expect(card().querySelector('dl')).toBeNull();
    expect(card().querySelector('p')!.textContent).toBe('고른 것이 없어요');
    await render(<SummaryCard emptyLabel="비었어요" title="요약" items={[]} />);
    expect(card().querySelector('p')).toBeNull();
    expect(card().querySelector('dl')).toBeNull();
  });

  it('값 글은 어디서나 줄바꿈되고 항목은 칸을 밀지 않는다(초장문이 칸을 안 넘친다)', async () => {
    await render(<SummaryCard emptyLabel="비었어요" title="요약" items={[{ id: 1, label: 'a', value: 'x'.repeat(100) }]} />);
    const dd = rows()[0]!.querySelector('dd')!;
    expect(has(dd, 'break-keep')).toBe(true);
    expect(has(dd, '[overflow-wrap:anywhere]')).toBe(true);
    expect(has(rows()[0]!, 'min-w-0')).toBe(true);
  });

  it('호출부 className · 속성이 닿고 data-slot은 덮이지 않는다 · 제목 id는 카드마다 다르다', async () => {
    await render(<><SummaryCard emptyLabel="비었어요" title="가" items={ITEMS} className="mt-2" data-testid="s1" {...({ 'data-slot': 'evil' } as object)} /><SummaryCard emptyLabel="비었어요" title="나" items={ITEMS} /></>);
    const cards = Array.from(container.querySelectorAll('[data-slot="ds-summary-card"]'));
    expect(cards.length).toBe(2);
    expect(has(cards[0]!, 'mt-2')).toBe(true);
    expect(cards[0]!.getAttribute('data-testid')).toBe('s1');
    expect(cards[0]!.querySelector('h2')!.id).not.toBe(cards[1]!.querySelector('h2')!.id);
  });
});
