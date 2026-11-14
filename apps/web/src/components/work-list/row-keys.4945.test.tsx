// @vitest-environment jsdom
//
// story 4945 — 일감 목록 탭: 행 사이 방향키 ↑↓(격리 맥 앱 실측: ↓를 눌러도 초점이 그대로였다 — Tab만 다음 행으로 갔다) · (커서는 건드리지 않는다 — 화살표 그대로가 맥 앱 관례).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GoalGroupView } from './work-list-goal-group';
import { moveWorkRowFocus } from './row-keys';
import type { WorkListGoalGroup } from './derive-work-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => { const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); el.dispatchEvent(ev); return ev; };

describe('moveWorkRowFocus — 화면 순서의 이웃 행', () => {
  function mount() {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.innerHTML = `<div id="list"><button id="head">구간 머리</button><div data-work-row tabindex="0" id="r1"></div><div data-work-row tabindex="0" id="r2"></div><div data-work-row tabindex="0" id="r3"></div><input id="field"/></div>`;
    document.body.appendChild(host);
    const list = host.querySelector('#list') as HTMLElement;
    list.addEventListener('keydown', (e) => moveWorkRowFocus(e as never));
    return (id: string) => host.querySelector('#' + id) as HTMLElement;
  }
  it('⭐↓↑ = 이웃 행으로 초점 · 처음/끝에서는 안 움직인다 · preventDefault(스크롤 안 끌려감)', () => {
    const $ = mount();
    $('r1').focus();
    const ev = key($('r1'), 'ArrowDown');
    expect(document.activeElement).toBe($('r2'));
    expect(ev.defaultPrevented).toBe(true);
    key($('r2'), 'ArrowDown'); expect(document.activeElement).toBe($('r3'));
    key($('r3'), 'ArrowDown'); expect(document.activeElement).toBe($('r3'));
    key($('r3'), 'ArrowUp'); expect(document.activeElement).toBe($('r2'));
    $('r1').focus(); key($('r1'), 'ArrowUp'); expect(document.activeElement).toBe($('r1'));
  });
  it('행이 아닌 곳(구간 머리 단추) · 글자 칸 · 수정 키가 같이 눌린 ↓는 아무것도 안 한다', () => {
    const $ = mount();
    $('head').focus(); key($('head'), 'ArrowDown'); expect(document.activeElement).toBe($('head'));
    $('r1').focus(); key($('r1'), 'ArrowDown', { metaKey: true }); expect(document.activeElement).toBe($('r1'));
    $('field').focus(); key($('field'), 'ArrowDown'); expect(document.activeElement).toBe($('field'));
  });
});

describe('스토리 행 — 방향키 대상이다(커서는 맥 앱 관례대로 화살표 그대로)', () => {
  it('⭐스토리 행은 data-work-row · 손가락 커서(cursor-pointer)는 안 단다(손가락은 글 링크뿐 — PO 11-15)', async () => {
    const group = {
      goalId: 'g1', goalTitle: '목표', stories: [{
        storyId: 'st1', title: '스토리 하나', status: 'in-progress',
        selfRow: { id: 'story:st1', title: '스토리 하나', state: null, artifactCount: 0, lowRisk: false, isDelegated: false, ownerName: null },
        rows: [],
      }],
    } as unknown as WorkListGoalGroup;
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><GoalGroupView group={group} selectedRowId={null} onSelect={() => {}} /></NextIntlClientProvider>); });
    const row = container.querySelector<HTMLElement>('[data-work-row]')!;
    expect(row).not.toBeNull();
    expect(row.className).not.toContain('cursor-pointer');
  });
});

describe('연결 — 진짜 일감 목록 틀이 이 키 처리를 단다(가드: 글 그대로)', () => {
  it('⭐work-list-shell의 묶음 뿌리에 onKeyDown={moveWorkRowFocus}가 있다(없으면 진짜 목록은 ↑↓를 무시한다)', () => {
    const src = readFileSync(join(__dirname, 'work-list-shell.tsx'), 'utf8');
    expect(/data-testid="work-list-groups"[^>]*onKeyDown=\{moveWorkRowFocus\}/.test(src)).toBe(true);
  });
});
