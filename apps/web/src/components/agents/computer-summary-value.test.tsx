// @vitest-environment jsdom
/**
 * story 5035 follow-up (PO's Two-Pass on 390) — the «실행 위치» value: the sentence keeps its words whole (`break-keep`), the state is held to its «·» (no-break space), the link appears only with a href and stays one piece.
 * The real wrapping is measured in a browser (e2e/computer-summary.5035.layout.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComputerSummaryValue } from './computer-summary-value';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
const render = (props: Parameters<typeof ComputerSummaryValue>[0]) => act(async () => { root.render(<ComputerSummaryValue {...props} />); });
const line = () => container.querySelector('[data-testid="agent-running-on-line"]') as HTMLElement;

describe('ComputerSummaryValue', () => {
  it('⭐the sentence keeps Korean words whole (break-keep) and still wraps a very long device name', async () => {
    await render({ line: '지금 도는 컴퓨터: Mac · 끝', devicesHref: null, devicesLabel: '연결된 기기 보기' });
    expect(line().className).toContain('break-keep');
    expect(line().className).toContain('[overflow-wrap:anywhere]');
  });
  it('⭐the text is UNCHANGED (the old tests read it with plain spaces) and the «· state» tail is one unbreakable piece', async () => {
    await render({ line: '지금 도는 컴퓨터: Mac · 끝', devicesHref: null, devicesLabel: 'x' });
    expect(line().textContent).toBe('지금 도는 컴퓨터: Mac · 끝');
    const tail = container.querySelector('[data-testid="agent-running-on-tail"]') as HTMLElement;
    expect(tail.textContent).toBe('· 끝');
    expect(tail.className).toContain('whitespace-nowrap');
  });
  it('a sentence with no «·» has no tail piece and is left as it is; the last «·» is the cut (the bound-not-run line has one too)', async () => {
    await render({ line: 'Mac에 연결됨 · 아직 안 돌았어요', devicesHref: null, devicesLabel: 'x' });
    expect(line().textContent).toBe('Mac에 연결됨 · 아직 안 돌았어요');
    expect((container.querySelector('[data-testid="agent-running-on-tail"]') as HTMLElement).textContent).toBe('· 아직 안 돌았어요');
    await render({ line: '아직 연결되지 않았어요', devicesHref: null, devicesLabel: 'x' });
    expect(line().textContent).toBe('아직 연결되지 않았어요');
    expect(container.querySelector('[data-testid="agent-running-on-tail"]')).toBeNull();
  });
  it('⭐the devices link only with a href; one piece (nowrap); the old test ids stay', async () => {
    await render({ line: 'a · b', devicesHref: null, devicesLabel: '연결된 기기 보기' });
    expect(container.querySelector('[data-testid="agent-see-devices"]')).toBeNull();
    await render({ line: 'a · b', devicesHref: '/desktop#device=s1', devicesLabel: '연결된 기기 보기' });
    const link = container.querySelector('[data-testid="agent-see-devices"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/desktop#device=s1');
    expect(link.className).toContain('whitespace-nowrap');
    expect(link.closest('[data-testid="agent-running-on"]')).not.toBeNull();
  });
});
