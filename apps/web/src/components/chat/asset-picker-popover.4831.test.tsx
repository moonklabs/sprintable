// @vitest-environment jsdom
//
// story 4831 덮개 — 자산 고르기(AssetPickerPopover)는 바탕 Popover로 옮기지 않고 «까닭 + 현재 동작을 잠그는 시험»과 함께 덮개 명단에 남는다.
// 까닭: 채팅 입력창 «안»(absolute bottom-14 left-3)에 붙은 콤보박스라 트리거가 이 컴포넌트에 없고, 초점이 계속 검색 칸에 머물며 목록은 aria-activedescendant로 탄다 —
// base-ui Popover는 위치 기준 · 초점 이동 · Esc 층이 달라진다. 이 파일이 그 현재 동작을 잠근다(옮기려면 이 시험이 먼저 빨개져야 한다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AssetPickerPopover } from './asset-picker-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { id: 'a1', name: '기획서.pdf', content_type: 'application/pdf', size_bytes: 2048 },
  { id: 'a2', name: '시안.png', content_type: 'image/png', size_bytes: 4096 },
  { id: 'a3', name: '메모.txt', content_type: 'text/plain', size_bytes: 512 },
];

let container: HTMLDivElement;
let root: Root;
const originalScrollIntoView = Element.prototype.scrollIntoView as typeof Element.prototype.scrollIntoView | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { items: ITEMS } }) })));
  Element.prototype.scrollIntoView = vi.fn(); // jsdom에는 없다 — 켠 항목을 목록 안으로 굴리는 호출
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  // 이 파일이 얹은 스텁이 같은 워커의 다른 시험으로 새지 않게 원래대로(jsdom엔 원래 없다)
  if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);
const chats = koMessages.chats as unknown as Record<string, string>;

async function mountPicker(props: { onSelect?: (a: unknown) => void; onClose?: () => void } = {}) {
  const onSelect = props.onSelect ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  await act(async () => { root.render(wrap(<AssetPickerPopover projectId="proj-1" onSelect={onSelect as never} onClose={onClose} />)); });
  return { onSelect, onClose };
}
const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const key = (k: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('AssetPickerPopover — 덮개 명단 잠금(현재 동작)', () => {
  it('호출부(입력창) 안에 absolute로 붙는 role=dialog이고 접근 이름이 제목이다 — 포털이 아니고 fixed가 아니다(트리거가 없다)', async () => {
    await mountPicker();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe(chats.assetPickerTitle);
    expect(hasClass(dialog, 'absolute')).toBe(true);
    expect(hasClass(dialog, 'fixed')).toBe(false);
    expect(container.contains(dialog)).toBe(true); // body로 나가는 포털이 아니라 호출부 트리 안에 그려진다
  });

  it('열리면 초점이 검색 칸(콤보박스)으로 간다', async () => {
    await mountPicker();
    await sleep(20);
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-controls')).toBe('asset-picker-list');
  });

  it('결과는 listbox/option이고 첫 항목이 켜져 있다(aria-activedescendant · aria-selected)', async () => {
    await mountPicker();
    await sleep(20);
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options()).toHaveLength(3);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe('asset-opt-0');
  });

  it('↓ ↑로 켠 항목이 돌아가며(맨 끝에서 처음으로) 초점은 검색 칸에 머문다', async () => {
    await mountPicker();
    await sleep(20);
    await key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('asset-opt-1');
    expect(options().filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1); // 켜진 항목은 정확히 하나
    expect(container.querySelector(`#${input().getAttribute('aria-activedescendant')}`)?.getAttribute('role')).toBe('option'); // 가리키는 id가 실제 option
    await key('ArrowDown'); await key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('asset-opt-0'); // 3 → 0으로 돌아감
    await key('ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe('asset-opt-2'); // 0 → 끝으로 돌아감
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(input());
  });

  it('Enter는 켜진 항목을 고른다', async () => {
    const { onSelect } = await mountPicker();
    await sleep(20);
    await key('ArrowDown');
    await key('Enter');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect((onSelect as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ id: 'a2' });
  });

  it('항목을 마우스로 누르면(mousedown) 그 항목을 고르고 검색 칸의 초점을 빼앗지 않는다', async () => {
    const { onSelect } = await mountPicker();
    await sleep(20);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { options()[2]!.dispatchEvent(ev); });
    expect((onSelect as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ id: 'a3' });
    expect(ev.defaultPrevented).toBe(true); // 입력칸이 초점을 잃지 않게
  });

  it('Esc는 검색 칸에서 한 층만 닫는다(onClose 1번)', async () => {
    const { onClose } = await mountPicker();
    await sleep(20);
    await key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('바깥을 누르면(mousedown) 닫고, 안쪽을 누르면 닫지 않는다 — 단, 다음 프레임에 리스너가 달리기 전(열린 같은 틱)의 누름은 무시한다', async () => {
    // 실제 타이머에 기대면 부하에 따라 흔들리므로 requestAnimationFrame을 손으로 쥔다 — 프레임을 «돌리기 전/후»를 결정적으로 가른다
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { onClose } = await mountPicker();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // 열자마자(프레임 전) — 메뉴 항목 클릭이 피커를 여는 누름
    expect(onClose).not.toHaveBeenCalled();
    expect(frames.length).toBeGreaterThan(0); // 리스너 등록이 다음 프레임으로 미뤄져 있다
    await act(async () => { frames.splice(0).forEach((cb) => cb(0)); }); // 프레임이 돌아 리스너가 달린다
    const dialog = container.querySelector('[role="dialog"]')!;
    await act(async () => { dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled(); // 안쪽
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1); // 바깥
  });

  it('결과가 없으면 빈 상태 안내가 뜨고 목록에 option이 없다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { items: [] } }) })));
    await mountPicker();
    await sleep(20);
    expect(options()).toHaveLength(0);
    expect(container.textContent).toContain(chats.assetPickerEmptyTitle);
  });
});
