// @vitest-environment jsdom
// UI-3(a9d56577) — ds Timeline 회귀가드: ol 목록 + 이름 필수 · 점 색 = 뜻(done · needs-hand · action) + 읽히는 글 · 세로선 모양(첫/끝) · 시각(time) · 행위자 칸 · 문장 줄바꿈.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Timeline, TimelineItem } from './timeline';

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
const list = () => container.querySelector('[data-slot="ds-timeline"]') as HTMLElement;
const items = () => Array.from(container.querySelectorAll('[data-slot="ds-timeline-item"]')) as HTMLElement[];
const dot = (i: number) => items()[i]!.querySelector('[data-slot="ds-timeline-dot"]') as HTMLElement;
const has = (el: Element, c: string) => el.className.split(/\s+/).includes(c);

describe('ds Timeline', () => {
  it('⭐ol 목록 + 이름 필수(aria-label) + 줄 수만큼 li', async () => {
    await render(
      <Timeline aria-label="활동 이력">
        <TimelineItem time="14:02">시작했어요</TimelineItem>
        <TimelineItem time="14:10">끝냈어요</TimelineItem>
      </Timeline>,
    );
    expect(list().tagName).toBe('OL');
    expect(list().getAttribute('aria-label')).toBe('활동 이력');
    expect(items().length).toBe(2);
  });

  it('⭐점 색은 뜻: 기본 action · 끝남 done · 손 필요 needs-hand-bar — 점은 장식(aria-hidden)', async () => {
    await render(
      <Timeline aria-label="이력">
        <TimelineItem time="1">a</TimelineItem>
        <TimelineItem time="2" tone="done" toneLabel="끝남">b</TimelineItem>
        <TimelineItem time="3" tone="needs-hand" toneLabel="내 손이 필요">c</TimelineItem>
      </Timeline>,
    );
    expect(has(dot(0), 'bg-ds-action')).toBe(true);
    expect(has(dot(1), 'bg-ds-done')).toBe(true);
    expect(has(dot(2), 'bg-ds-needs-hand-bar')).toBe(true);
    for (const i of [0, 1, 2]) expect(dot(i).getAttribute('aria-hidden')).toBe('true');
  });

  it('⭐뜻이 있는 점은 보이지 않는 글이 읽힌다(색만으로 말하지 않는다) · 기본 점엔 없다', async () => {
    await render(
      <Timeline aria-label="이력">
        <TimelineItem time="1">평범</TimelineItem>
        <TimelineItem time="2" tone="needs-hand" toneLabel="내 손이 필요">승인 대기</TimelineItem>
      </Timeline>,
    );
    expect(items()[0]!.querySelector('.sr-only')).toBeNull();
    expect(items()[1]!.querySelector('.sr-only')!.textContent).toBe('내 손이 필요 ');
    expect(items()[1]!.textContent).toContain('내 손이 필요 승인 대기');
  });

  it('⭐세로선: 모든 줄에 선이 있고 첫 줄은 점에서 시작 · 마지막 줄은 점에서 끝난다', async () => {
    await render(
      <Timeline aria-label="이력">
        <TimelineItem time="1">a</TimelineItem>
        <TimelineItem time="2">b</TimelineItem>
        <TimelineItem time="3">c</TimelineItem>
      </Timeline>,
    );
    for (const li of items()) {
      expect(has(li, 'before:absolute')).toBe(true);
      expect(has(li, 'before:bg-ds-line')).toBe(true);
      expect(has(li, 'before:w-px')).toBe(true);
    }
    expect(has(items()[0]!, 'first:before:top-2.5')).toBe(true);
    expect(has(items()[2]!, 'last:before:h-2.5')).toBe(true);
    expect(has(items()[2]!, 'last:before:bottom-auto')).toBe(true);
  });

  it('⭐시각: dateTime을 주면 <time datetime> 요소 · 없으면 요소 없이 글만', async () => {
    await render(
      <Timeline aria-label="이력">
        <TimelineItem time="14:02" dateTime="2026-11-11T14:02:00+09:00">a</TimelineItem>
        <TimelineItem time="14:10">b</TimelineItem>
      </Timeline>,
    );
    const t = items()[0]!.querySelector('time')!;
    expect(t.getAttribute('datetime')).toBe('2026-11-11T14:02:00+09:00');
    expect(t.textContent).toBe('14:02');
    expect(items()[1]!.querySelector('time')).toBeNull();
    expect(items()[1]!.textContent).toContain('14:10');
    for (const i of [0, 1]) expect(has(items()[i]!.querySelector('time, span.font-mono') as Element, 'font-mono')).toBe(true);
  });

  it('행위자 칸: 주면 그려지고 없으면 칸 자체가 없다', async () => {
    await render(
      <Timeline aria-label="이력">
        <TimelineItem time="1" actor={<i data-testid="av" />}>a</TimelineItem>
        <TimelineItem time="2">b</TimelineItem>
      </Timeline>,
    );
    expect(items()[0]!.querySelector('[data-slot="ds-timeline-actor"] [data-testid="av"]')).not.toBeNull();
    expect(items()[1]!.querySelector('[data-slot="ds-timeline-actor"]')).toBeNull();
  });

  it('문장은 어디서나 줄바꿈된다(초장문이 줄을 안 넘친다)', async () => {
    await render(<Timeline aria-label="이력"><TimelineItem time="1">{'x'.repeat(200)}</TimelineItem></Timeline>);
    const p = items()[0]!.querySelector('p')!;
    expect(has(p, 'min-w-0')).toBe(true);
    expect(has(p, 'break-keep')).toBe(true);
    expect(has(p, '[overflow-wrap:anywhere]')).toBe(true);
  });

  it('호출부 className · 속성이 목록 · 줄에 닿고 data-slot은 덮이지 않는다', async () => {
    await render(
      <Timeline aria-label="이력" className="mt-2" data-testid="tl" {...({ 'data-slot': 'evil' } as object)}>
        <TimelineItem time="1" className="py-1" data-testid="it" {...({ 'data-slot': 'evil' } as object)}>a</TimelineItem>
      </Timeline>,
    );
    expect(has(list(), 'mt-2')).toBe(true);
    expect(list().getAttribute('data-testid')).toBe('tl');
    expect(list().getAttribute('data-slot')).toBe('ds-timeline');
    expect(has(items()[0]!, 'py-1')).toBe(true);
    expect(items()[0]!.getAttribute('data-slot')).toBe('ds-timeline-item');
  });
});
