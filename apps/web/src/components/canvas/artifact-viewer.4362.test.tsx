// @vitest-environment jsdom
//
// [SID:4362] 390/360 스토리 패널 산출물 카드 — 머리가 nowrap 한 줄이라 조작 글자가 한 글자씩 세로로 쌓이고(한글 최소 폭 = 한 글자) 제목이
// 0~8px로 눌렸다 · 캔버스 도구줄 «전체 보기» · «실제 크기»도 낱말 중간에서 꺾였다. jsdom은 배치를 안 해서 배치를 정하는 클래스를 못박는다
// (실제 폭은 헤드리스 Chromium 판 — PR 본문 표).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { MOCK_ARTIFACT, MOCK_MEMBERS, MOCK_VERSIONS } from '@/services/canvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ArtifactViewer artifact={{ ...MOCK_ARTIFACT, format: 'html' }} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onProposeCanonical={() => {}} onCreateThread={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}
const cls = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
const K = koMessages.canvas;

describe('산출물 카드 머리 · 도구줄 — 좁은 폭에서 줄을 넘기고 조작 글자는 안 꺾임([SID:4362])', () => {
  it('머리: flex-wrap(제목 줄 / 조작 줄) · 제목은 줄어들 수 있게(min-w-0 · max-w-full · truncate)', () => {
    mount();
    const title = [...container.querySelectorAll('span')].find((s) => s.textContent === MOCK_ARTIFACT.title)!;
    const head = title.parentElement!;
    expect(cls(head)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(cls(title)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full', 'truncate']));
  });

  it('머리 조작(크게 보기 · 정본으로 제안 · 내보내기 · 판 고르기 · 형식 표 · 정본 표 · 오른쪽 무리): shrink-0 · 글자 있는 것은 whitespace-nowrap', () => {
    mount();
    const title = [...container.querySelectorAll('span')].find((s) => s.textContent === MOCK_ARTIFACT.title)!;
    const head = title.parentElement!;
    const labelled = [K.viewerExpandAction, K.proposeCanonicalAction, K.exportDialogTitle].map((txt) => [...head.querySelectorAll('button')].find((b) => b.textContent?.includes(txt))!);
    expect(labelled.every(Boolean)).toBe(true);
    // 버튼 자신이 머리 직속이면 자기가, 무리(오른쪽 ml-auto) 안이면 그 무리가 shrink-0 · whitespace-nowrap(글자는 이어받음).
    for (const b of labelled) {
      let top: Element = b;
      while (top.parentElement && top.parentElement !== head) top = top.parentElement;
      expect(cls(top), b.textContent ?? '').toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    }
    for (const child of [...head.children].filter((c) => c !== title)) expect(cls(child), child.outerHTML.slice(0, 60)).toContain('shrink-0');
  });

  it('캔버스 도구줄: flex-wrap · 안내 글 min-w-0 · 버튼 무리 shrink-0 · whitespace-nowrap(«전체 보기» · «실제 크기»)', () => {
    mount();
    const fit = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(K.viewerFitAction))!;
    const group = fit.parentElement!;
    const bar = group.parentElement!;
    expect(cls(bar)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(cls(group)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    expect(cls(bar.querySelector('p')!)).toContain('min-w-0');
  });
});
