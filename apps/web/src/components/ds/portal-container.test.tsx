// UI-3(a9d56577) — DsPortalContainer 회귀가드: 감싸개가 있으면 팝업(Dialog · Panel · Menu · DatePicker)이 그 요소 «안»에 그려지고, 없으면 기존처럼 document.body에 그려진다.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DsPortalContainer } from './portal-container';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';
import { Panel, PanelContent, PanelHeader, PanelTitle } from './panel';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './menu';
import { DatePicker } from './date-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let target: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  target = document.createElement('div');
  target.setAttribute('data-test-target', '');
  document.body.append(container, target);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  target.remove();
});
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }

const LABELS = { date: '시작일', placeholder: '날짜 고르기', previousMonth: '이전 달', nextMonth: '다음 달' };
const parts = (open = true) => (
  <>
    <Dialog open={open}><DialogContent aria-label="창"><DialogHeader><DialogTitle>제목</DialogTitle><DialogDescription>설명</DialogDescription></DialogHeader></DialogContent></Dialog>
    <Panel open={open}><PanelContent aria-label="패널"><PanelHeader><PanelTitle>패널 제목</PanelTitle></PanelHeader></PanelContent></Panel>
    <Menu open={open}><MenuTrigger>더보기</MenuTrigger><MenuContent><MenuItem>삭제</MenuItem></MenuContent></Menu>
    <DatePicker value={null} onChange={() => {}} today="2026-11-11" locale="ko" labels={LABELS} />
  </>
);
const SELECTORS = ['[data-slot="ds-dialog-content"]', '[data-slot="ds-panel"]', '[data-slot="ds-menu-content"]'];

describe('DsPortalContainer', () => {
  it('⭐감싸개 안의 팝업은 지정한 요소 «안»에 그려진다 — Dialog · Panel · Menu · DatePicker 넷 다', async () => {
    await render(<DsPortalContainer container={target}>{parts()}</DsPortalContainer>);
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      expect(el, sel).not.toBeNull();
      expect(target.contains(el), sel).toBe(true);
    }
    await act(async () => { (container.querySelector('[data-slot="ds-date-picker"]') as HTMLButtonElement).click(); });
    const picker = document.querySelector('[data-slot="ds-date-picker-popup"]');
    expect(picker).not.toBeNull();
    expect(target.contains(picker)).toBe(true);
  });

  it('⭐감싸개가 없으면 기존처럼 body 바로 아래(지정 요소 밖)에 그려진다 — 제품 화면은 달라지지 않는다', async () => {
    await render(parts());
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      expect(el, sel).not.toBeNull();
      expect(target.contains(el), sel).toBe(false);
    }
    await act(async () => { (container.querySelector('[data-slot="ds-date-picker"]') as HTMLButtonElement).click(); });
    expect(target.contains(document.querySelector('[data-slot="ds-date-picker-popup"]'))).toBe(false);
  });

  it('container가 null이면 감싸개가 없는 것과 같다(아직 요소가 없을 때)', async () => {
    await render(<DsPortalContainer container={null}>{parts()}</DsPortalContainer>);
    expect(target.contains(document.querySelector('[data-slot="ds-dialog-content"]'))).toBe(false);
    expect(document.querySelector('[data-slot="ds-dialog-content"]')).not.toBeNull();
  });
});
