// UI-3(a9d56577) — ds Dialog · ConfirmDialog · Panel 회귀가드: 열림 · 제목 연결 · 닫기 이름 · Esc · 위험 확인 초점 · 로딩 · 패널 배치.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

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
const wrap = (n: ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{n}</NextIntlClientProvider>;
async function render(n: ReactNode) { await act(async () => { root.render(wrap(n)); }); }
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog';
import { Panel, PanelBody, PanelContent, PanelHeader, PanelTitle } from './panel';

const popup = () => document.querySelector('[data-slot="ds-dialog-content"]') as HTMLElement | null;

describe('ds Dialog', () => {
  it('열리면 role=dialog이고 제목 · 설명에 이어진다(이름 있는 창)', async () => {
    await render(
      <Dialog open>
        <DialogContent aria-label="창">
          <DialogHeader><DialogTitle>이 문서를 지울까요</DialogTitle><DialogDescription>되돌릴 수 없어요</DialogDescription></DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    const p = popup()!;
    expect(p.getAttribute('role')).toBe('dialog');
    const labelledby = p.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledby)!.textContent).toBe('이 문서를 지울까요');
    expect(p.className).toContain('bg-ds-surface-raised');
    expect(p.className).toContain('border-ds-line-control');
    expect(p.className).toContain('sm:max-w-105');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
    expect(overlay.className).toContain('bg-ds-scrim/55');
    expect(overlay.className).not.toContain('bg-scrim-2');
  });

  it('닫기(X)는 기본으로 있고 이름이 «닫기», showCloseButton=false면 없다', async () => {
    await render(<Dialog open><DialogContent aria-label="창"><DialogTitle>t</DialogTitle></DialogContent></Dialog>);
    expect(popup()!.querySelector('button[aria-label="닫기"]')).not.toBeNull();
    expect(popup()!.getAttribute('data-close-button')).toBe('');
    await render(<Dialog open><DialogContent aria-label="창" showCloseButton={false}><DialogTitle>t</DialogTitle></DialogContent></Dialog>);
    expect(popup()!.querySelector('button[aria-label="닫기"]')).toBeNull();
    expect(popup()!.hasAttribute('data-close-button')).toBe(false);
  });

  it('⭐닫기(X)가 없으면 머리 줄 · 제목은 오른쪽을 비우지 않는다 — 여백은 «닫기 표지가 있을 때만» 걸린다(무조건 pr-9 금지)', async () => {
    await render(<Dialog open><DialogContent aria-label="창" showCloseButton={false}><DialogHeader><DialogTitle>제목</DialogTitle></DialogHeader><DialogTitle>곧장</DialogTitle></DialogContent></Dialog>);
    const unconditional = /(^|\s)(pointer-coarse:)?pr-(9|14)(\s|$)/;
    expect(document.querySelector('[data-slot="ds-dialog-header"]')!.className).not.toMatch(unconditional);
    for (const title of document.querySelectorAll('[data-slot="ds-dialog-title"]')) expect(title.className).not.toMatch(unconditional);
    expect(popup()!.hasAttribute('data-close-button')).toBe(false);
  });

  it('⭐닫기(X)를 누르면 실제로 닫힘 요청이 간다(onOpenChange false)', async () => {
    const onOpenChange = vi.fn();
    await render(<Dialog open onOpenChange={onOpenChange}><DialogContent aria-label="창"><DialogTitle>t</DialogTitle></DialogContent></Dialog>);
    await act(async () => { (popup()!.querySelector('button[aria-label="닫기"]') as HTMLElement).click(); });
    expect(onOpenChange.mock.calls.at(-1)![0]).toBe(false);
  });

  it('⭐ConfirmDialog는 제목에 이어진 이름이 있다(aria-labelledby → 제목 글)', async () => {
    await render(<ConfirmDialog open onOpenChange={() => {}} title="지울까요" confirmLabel="지우기" cancelLabel="취소" onConfirm={() => {}} />);
    const p = popup()!;
    expect(document.getElementById(p.getAttribute('aria-labelledby')!)!.textContent).toBe('지울까요');
  });

  it('⭐머리 줄 밖의 제목은 닫기(X) 자리를 비운다 · 머리 줄 안의 제목은 이중으로 안 비운다', async () => {
    await render(<Dialog open><DialogContent aria-label="창"><DialogTitle>곧장 제목</DialogTitle></DialogContent></Dialog>);
    const cls = document.querySelector('[data-slot="ds-dialog-title"]')!.className;
    expect(cls).toContain('group-data-[close-button]/dialog:not-in-data-[slot=ds-dialog-header]:pr-9');
    expect(cls).toContain('pointer-coarse:pr-14');
    expect(popup()!.hasAttribute('data-close-button')).toBe(true);
  });

  it('⭐Esc로 닫힌다(onOpenChange false) — 한 Esc = 한 층 가드를 거친다', async () => {
    const onOpenChange = vi.fn();
    await render(<Dialog open onOpenChange={onOpenChange}><DialogContent aria-label="창"><DialogTitle>t</DialogTitle></DialogContent></Dialog>);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls[0]![0]).toBe(false);
  });
});

describe('ds ConfirmDialog', () => {
  const base = { open: true, onOpenChange: () => {}, title: '지울까요', confirmLabel: '지우기', cancelLabel: '취소', onConfirm: () => {} };

  it('아래 단추 줄에 취소(보조) + 확인(주)이 있고 닫기(X)는 없다', async () => {
    await render(<ConfirmDialog {...base} />);
    const buttons = [...popup()!.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['취소', '지우기']);
    expect(buttons[1]!.className).toContain('bg-ds-action');
    expect(popup()!.querySelector('button[aria-label="닫기"]')).toBeNull();
  });

  it('⭐위험 확인은 위험 Button이고 처음 초점이 «취소»에 놓인다(Enter 한 번으로 지우지 않게)', async () => {
    await render(<ConfirmDialog {...base} tone="danger" />);
    // Base UI는 열린 뒤 한 틈 뒤에 첫 초점을 옮긴다(4369 시험과 같은 기다림) — 그 뒤에 어디에 놓였는지 본다.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const buttons = [...popup()!.querySelectorAll('button')];
    expect(buttons[1]!.className).toContain('border-ds-failed');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('확인을 누르면 onConfirm, 일하는 중이면 확인이 aria-busy이고 눌러도 한 번도 안 불린다', async () => {
    const onConfirm = vi.fn();
    await render(<ConfirmDialog {...base} onConfirm={onConfirm} />);
    await act(async () => { ([...popup()!.querySelectorAll('button')][1] as HTMLElement).click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const busy = vi.fn();
    await render(<ConfirmDialog {...base} onConfirm={busy} loading />);
    const confirm = [...popup()!.querySelectorAll('button')][1] as HTMLElement;
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    await act(async () => { confirm.click(); });
    expect(busy).not.toHaveBeenCalled();
  });
});

describe('ds Panel', () => {
  it('넓은 화면은 오른쪽 폭 400 패널(lg:) · 좁은 화면은 아래 시트 — 레이아웃은 CSS 분기만', async () => {
    await render(
      <Panel open>
        <PanelContent aria-label="패널">
          <PanelHeader><PanelTitle>스레드</PanelTitle></PanelHeader>
          <PanelBody>본문</PanelBody>
        </PanelContent>
      </Panel>,
    );
    const p = document.querySelector('[data-slot="ds-panel"]') as HTMLElement;
    expect(p.getAttribute('role')).toBe('dialog');
    expect(p.className).toContain('lg:w-100');
    expect(p.className).toContain('lg:right-0');
    expect(p.className).toContain('max-h-[92dvh]');
    expect(p.className).toContain('bottom-0');
    expect(p.className).not.toMatch(/(^|\s)(sm|md):/);
    expect(p.querySelector('button[aria-label="닫기"]')).not.toBeNull();
    expect(p.querySelector('[data-slot="ds-panel-body"]')!.className).toContain('overflow-y-auto');
    expect((document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement).className).toContain('bg-ds-scrim/55');
  });

  it('⭐닫기(X)를 누르면 닫힘 요청이 간다', async () => {
    const onOpenChange = vi.fn();
    await render(<Panel open onOpenChange={onOpenChange}><PanelContent aria-label="패널"><PanelTitle>t</PanelTitle></PanelContent></Panel>);
    await act(async () => { (document.querySelector('[data-slot="ds-panel"] button[aria-label="닫기"]') as HTMLElement).click(); });
    expect(onOpenChange.mock.calls.at(-1)![0]).toBe(false);
  });

  it('Esc로 닫힌다', async () => {
    const onOpenChange = vi.fn();
    await render(<Panel open onOpenChange={onOpenChange}><PanelContent aria-label="패널"><PanelTitle>t</PanelTitle></PanelContent></Panel>);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(onOpenChange.mock.calls[0]![0]).toBe(false);
  });
});

describe('ds Dialog — Esc 규칙([SID:4369] 현행 Dialog와 같은 갈래)', () => {
  const esc = (t: EventTarget, init: KeyboardEventInit = {}) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));

  it('⭐글 있는 여러 줄 칸의 첫 Esc는 칸에서만 빠져나오고 창은 안 닫힌다 · 글은 그대로', async () => {
    const onOpenChange = vi.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent aria-label="창"><DialogTitle>반려</DialogTitle><textarea data-testid="reason" defaultValue="쓰던 사유" /></DialogContent>
      </Dialog>,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const ta = document.querySelector('[data-testid="reason"]') as HTMLTextAreaElement;
    await act(async () => { ta.focus(); });
    await act(async () => { esc(ta); });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(ta.value).toBe('쓰던 사유');
  });

  it('한글 조합 중 Esc는 창을 닫지 않는다', async () => {
    const onOpenChange = vi.fn();
    await render(<Dialog open onOpenChange={onOpenChange}><DialogContent aria-label="창"><DialogTitle>t</DialogTitle><input data-testid="line" /></DialogContent></Dialog>);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const input = document.querySelector('[data-testid="line"]') as HTMLInputElement;
    await act(async () => { input.focus(); });
    await act(async () => { esc(input, { isComposing: true }); });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('⭐패널 머리 줄은 닫기(X) 자리를 한 번만 비운다 — 제목은 «머리 줄 안»으로 읽혀 이중으로 안 비운다 · 폰(coarse)은 44 누름 영역만큼 더 비운다', async () => {
    await render(<Panel open><PanelContent aria-label="패널"><PanelHeader><PanelTitle>스레드</PanelTitle></PanelHeader></PanelContent></Panel>);
    const header = document.querySelector('[data-panel-header]') as HTMLElement;
    expect(header).not.toBeNull();
    // 제목이 «머리 줄 안» 판정(not-in-data-[slot=ds-dialog-header])을 받으려면 머리 줄이 ds-dialog-header 표지를 그대로 가져야 한다.
    expect(header.getAttribute('data-slot')).toBe('ds-dialog-header');
    expect(header.className).toContain('group-data-[close-button]/dialog:pr-9');
    expect(header.className).toContain('pointer-coarse:pr-14');
  });
});
