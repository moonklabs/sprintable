// @vitest-environment jsdom
// UI-3(a9d56577) — ds Metric 회귀가드: 이름 → 값 읽기 구조 · 고정폭 숫자 · 한도 · 변화 칸 · 값 없음(0과 모름을 안 섞음).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Metric } from './metric';

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
const m = () => container.querySelector('[data-slot="ds-metric"]') as HTMLElement;

describe('ds Metric', () => {
  it('⭐dl 한 쌍: dt = 이름 · dd = 값 — 스크린리더가 «이름 → 값»으로 읽는다', async () => {
    await render(<Metric label="끝낸 일감" value={12} />);
    expect(m().tagName).toBe('DL');
    expect(m().querySelector('dt')!.textContent).toBe('끝낸 일감');
    expect(m().querySelector('dd')!.textContent).toBe('12');
  });

  it('⭐숫자는 고정폭 · 자리 맞춤 · title 크기, 이름은 작은 글 ink-3', async () => {
    await render(<Metric label="끝낸 일감" value={12} />);
    const v = m().querySelector('dd > span') as HTMLElement;
    expect(v.className).toContain('font-mono');
    expect(v.className).toContain('tabular-nums');
    expect(v.className).toContain('text-ds-title');
    expect(m().querySelector('dt')!.className).toContain('text-ds-ink-3');
    expect(m().querySelector('dt')!.className).toContain('text-ds-small');
  });

  it('«/한도»는 숫자 뒤에 ink-3으로, 한도가 없으면 안 그린다', async () => {
    await render(<Metric label="사용량" value={12} limit={40} />);
    expect(m().querySelector('dd')!.textContent).toBe('12 / 40');
    expect(m().querySelector('dd')!.innerHTML).toContain('text-ds-ink-3');
    await render(<Metric label="사용량" value={12} />);
    expect(m().querySelector('dd')!.textContent).toBe('12');
  });

  it('⭐한도 0은 «0 / 0»으로 그려진다(없는 한도와 다르다)', async () => {
    await render(<Metric label="쿼터" value={0} limit={0} />);
    expect(m().querySelector('dd')!.textContent).toBe('0 / 0');
  });

  it('⭐값이 null · undefined로 오면(JS · a?.b) 빈 칸이 아니라 보이는 «—»', async () => {
    for (const v of [undefined, null]) {
      const bad = { value: v } as unknown as { value: number };
      await render(<Metric label="끝낸 일감" {...bad} />);
      expect(m().querySelector('dd')!.textContent, String(v)).toBe('—');
      expect(m().querySelector('dd [aria-hidden]'), String(v)).toBeNull();
    }
  });

  it('⭐긴 값 · 한도도 칸 밖으로 안 넘친다(줄바꿈 허용 + min-w-0)', async () => {
    await render(<Metric label="토큰" value={'1'.repeat(30)} limit={'9'.repeat(30)} />);
    const spans = [...m().querySelectorAll('dd > span')] as HTMLElement[];
    for (const sp of spans) {
      expect(sp.className).toContain('min-w-0');
      expect(sp.className).toContain('[overflow-wrap:anywhere]');
    }
  });

  it('변화 칸(delta)이 오른쪽에 실리고 호출부 노드가 그대로 산다', async () => {
    await render(<Metric label="사용량" value={12} delta={<span data-testid="d">+3</span>} />);
    const d = m().querySelector('[data-testid="d"]') as HTMLElement;
    expect(d.textContent).toBe('+3');
    expect((d.parentElement as HTMLElement).className).toContain('ml-auto');
  });

  it('⭐값 · 한도 · 변화 사이에 읽는 공백이 있다(«12 / 40 3%», 붙어 «403%»로 읽히지 않는다)', async () => {
    await render(<Metric label="사용량" value={12} limit={40} delta={<span>3%</span>} />);
    expect(m().querySelector('dd')!.textContent).toBe('12 / 40 3%');
    await render(<Metric label="사용량" value={12} delta={<span>3%</span>} />);
    expect(m().querySelector('dd')!.textContent).toBe('12 3%');
  });

  it('⭐변화 0도 그려진다(falsy라고 숨기지 않는다)', async () => {
    await render(<Metric label="사용량" value={12} delta={0} />);
    expect(m().querySelector('dd')!.textContent).toBe('12 0');
  });

  it('아이콘은 이름 앞에서 장식으로만(이름 글이 뜻을 싣는다)', async () => {
    await render(<Metric label="끝낸 일감" icon="check_circle" value={12} />);
    expect(m().querySelector('dt [data-icon="check_circle"]')).not.toBeNull();
    expect(m().querySelector('dt')!.textContent).toBe('끝낸 일감');
  });

  it('⭐아이콘의 뜻 색(done · failed · info · action)은 고를 때만, 기본은 중립 — 이름 글은 그대로', async () => {
    const want = { neutral: 'text-ds-ink-3', done: 'text-ds-done', failed: 'text-ds-failed', info: 'text-ds-info', action: 'text-ds-action-text' } as const;
    for (const [tone, cls] of Object.entries(want)) {
      await render(<Metric label="끝낸 일감" icon="check_circle" iconTone={tone as never} value={1} />);
      expect(m().querySelector('dt svg')!.getAttribute('class'), tone).toContain(cls);
    }
    await render(<Metric label="끝낸 일감" icon="check_circle" value={1} />);
    expect(m().querySelector('dt svg')!.getAttribute('class')).toContain('text-ds-ink-3');
  });

  it('⭐값을 못 구하면 «—»(장식) + 읽히는 이유 — 0으로 보이지 않고 한도 · 변화도 숨는다', async () => {
    await render(<Metric label="끝낸 일감" unavailable unavailableLabel="불러오지 못했어요" limit={40} delta={<span>+3</span>} />);
    expect(m().getAttribute('data-unavailable')).toBe('true');
    const dd = m().querySelector('dd') as HTMLElement;
    expect(dd.querySelector('[aria-hidden="true"]')!.textContent).toBe('—');
    expect(dd.querySelector('.sr-only')!.textContent).toBe('불러오지 못했어요');
    expect(dd.textContent).not.toContain('40');
    expect(dd.textContent).not.toContain('+3');
    expect(dd.textContent).not.toMatch(/(^|[^\d])0([^\d]|$)/);
  });

  it('값 0은 0으로 그려진다(모름과 다르다)', async () => {
    await render(<Metric label="끝낸 일감" value={0} />);
    expect(m().querySelector('dd')!.textContent).toBe('0');
    expect(m().hasAttribute('data-unavailable')).toBe(false);
  });
});
