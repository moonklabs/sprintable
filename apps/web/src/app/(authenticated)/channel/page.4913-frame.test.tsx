// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import enMessages from '../../../../messages/en.json';
import ChannelPage from './page';

// story 4913 (UI-R5 · 채널) — the channel screen on the one-page frame: title above (OrgScreenTitle), PageFrame stream, a text status chip (not a coloured dot), the failures said, the person's words kept when a send is refused.
const { search, ctx, topBar } = vi.hoisted(() => ({
  search: { value: 'agent_id=ag-1' },
  ctx: { currentTeamMemberId: 'me-1' },
  topBar: { titles: [] as unknown[] },
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search.value) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ctx }));
vi.mock('@/components/nav/top-bar-slot', () => ({ TopBarSlot: ({ title }: { title: unknown }) => { topBar.titles.push(title); return null; } }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
vi.mock('@/lib/hover-reveal', () => ({ HOVER_REVEAL: '', HOVER_REVEAL_FOCUS_RING: '', HOVER_REVEAL_HIT: '' }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const C = koMessages.channel;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  receive(m: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

let container: HTMLDivElement;
let root: Root;
let calls: Array<{ url: string; method: string }>;
let tokenOk = true;
let deliverStatus = 200;
let uploadStatus = 200;
const NOW = new Date().toISOString();

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).includes('/api/channel/token')) return tokenOk ? new Response(JSON.stringify({ token: 't', backend_origin: 'https://api.test' }), { status: 200 }) : new Response('{}', { status: 500 });
    if (String(url).includes('/api/channel/deliver')) return new Response('{}', { status: deliverStatus });
    if (String(url).includes('/api/channel/upload')) return new Response('{}', { status: uploadStatus });
    return new Response('{}', { status: 200 });
  }));
}
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChannelPage /></NextIntlClientProvider>); });
  await settle();
}
const ws = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const box = () => container.querySelector('[data-testid="channel-input"]') as HTMLTextAreaElement;
function typeInto(value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), value);
  box().dispatchEvent(new Event('input', { bubbles: true }));
}
const status = () => container.querySelector('[data-testid="channel-status"]');

beforeEach(() => {
  FakeWebSocket.instances = []; topBar.titles = []; search.value = 'agent_id=ag-1'; tokenOk = true; deliverStatus = 200; uploadStatus = 200;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  Element.prototype.scrollIntoView = vi.fn();
  stubFetch();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('채널(채팅 흐름) — 한 쪽 틀(story 4913)', () => {
  it('⭐PageFrame stream 위에 서고, 본문에 h1이 없고(제목은 위 막대), 설명 한 줄 + 글 칩 하나가 머리에 선다', async () => {
    await mount();
    const frame = container.querySelector('[data-slot="ds-page-frame"]');
    expect(frame?.getAttribute('data-width')).toBe('stream');
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('[data-slot="ds-page-head"]')?.textContent).toContain(C.description);
    expect(topBar.titles.length).toBeGreaterThan(0); // the title goes to the bar through OrgScreenTitle
  });

  it('⭐연결 상태는 글 칩이다 — 연결 중 → 연결됨 → 연결 끊김(+ 끊김 안내 띠), 점 + 영어 title이 아니다', async () => {
    await mount();
    expect(status()?.textContent).toBe(C.statusConnecting);
    await act(async () => { ws().open(); });
    expect(status()?.textContent).toBe(C.statusConnected);
    expect(status()?.getAttribute('data-tone')).toBe('done');
    expect(container.querySelector('[data-testid="channel-disconnected"]')).toBeNull();
    await act(async () => { ws().drop(); });
    expect(status()?.textContent).toBe(C.statusDisconnected);
    expect(container.querySelector('[data-testid="channel-disconnected"]')?.textContent).toBe(C.disconnectedNote);
    expect(container.querySelector('[title="connected"],[title="disconnected"],[title="connecting"]')).toBeNull();
  });

  it('⭐메시지 줄 — 남의 것은 이름 + 면 «rowOthers», 내 것은 «rowMine»(이름 없음), 글 · 시각 · 첨부 링크, 답장 단추는 ds IconButton', async () => {
    await mount();
    await act(async () => {
      ws().open();
      ws().receive({ id: 'm1', sender_id: 'ag-1', sender_name: '시험 에이전트', content: '확인했어요', ts: NOW });
      ws().receive({ id: 'm2', sender_id: 'me-1', sender_name: '나', content: '고마워요', ts: NOW, file_url: '/api/v2/channel/files/x/report.pdf' });
    });
    const rows = [...container.querySelectorAll('[data-testid="channel-message"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-own')).toBe('false'); expect(rows[0].textContent).toContain('시험 에이전트');
    expect(rows[1].getAttribute('data-own')).toBe('true'); expect(rows[1].textContent).not.toContain('나고마워요');
    expect(rows[0].querySelector('.bg-ds-surface-high')).not.toBeNull();
    expect(rows[1].querySelector('.bg-ds-mine')).not.toBeNull();
    const link = rows[1].querySelector('a[download]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/channel/files/x/report.pdf'); expect(link.textContent).toBe(C.attachment);
    expect(rows[0].querySelector('[data-slot="ds-icon-button"], button[aria-label="' + C.reply + '"]')).not.toBeNull();
  });

  it('⭐옛 부품 · 옛 색이 없다 — 말풍선은 토큰(bg-brand · bg-muted · text-muted-foreground · lucide 아이콘 import 없음)', async () => {
    await mount();
    await act(async () => { ws().open(); ws().receive({ id: 'm1', sender_id: 'ag-1', sender_name: 'A', content: 'x', ts: NOW }); });
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-brand|bg-muted|text-muted-foreground|border-border|bg-background/);
    const src = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(src).not.toMatch(/lucide-react|components\/ui\//);
  });

  it('⭐보내기 — 소켓이 열려 있으면 소켓으로, 글은 비워지고, 한글 조합 중 Enter는 보내지 않는다', async () => {
    await mount();
    await act(async () => { ws().open(); });
    await act(async () => { typeInto('안녕'); });
    const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    await act(async () => { box().dispatchEvent(composing); });
    expect(ws().sent).toHaveLength(0);
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(ws().sent).toEqual([JSON.stringify({ content: '안녕' })]);
    expect(box().value).toBe('');
  });

  it('⭐소켓이 닫혀 있을 때 서버가 거절하면 — 실패 띠가 말하고 쓴 글은 칸에 그대로 돌아온다(전엔 말없이 지워졌다)', async () => {
    deliverStatus = 500;
    await mount();
    await act(async () => { ws().drop(); });
    await act(async () => { typeInto('다시 보낼 글'); });
    await act(async () => { (container.querySelector('[data-testid="channel-send"]') as HTMLButtonElement).click(); });
    await settle();
    expect(calls.some((c) => c.url.includes('/api/channel/deliver') && c.method === 'POST')).toBe(true);
    expect(container.querySelector('[data-testid="channel-send-failed"]')?.textContent).toBe(C.sendFailed);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(box().value).toBe('다시 보낼 글');
  });

  it('⭐파일을 붙여 보냈는데 서버가 거절하면 — 같은 실패 띠 · 글 · 붙인 파일(이름 띠)이 그대로 돌아온다', async () => {
    uploadStatus = 500;
    await mount();
    await act(async () => { ws().open(); });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'report.pdf', { type: 'application/pdf' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[data-testid="channel-file-strip"]')?.textContent).toContain('report.pdf');
    await act(async () => { typeInto('파일과 함께'); });
    await act(async () => { (container.querySelector('[data-testid="channel-send"]') as HTMLButtonElement).click(); });
    await settle();
    expect(calls.some((c) => c.url.includes('/api/channel/upload') && c.method === 'POST')).toBe(true);
    expect(container.querySelector('[data-testid="channel-send-failed"]')?.textContent).toBe(C.sendFailed);
    expect(box().value).toBe('파일과 함께');
    expect(container.querySelector('[data-testid="channel-file-strip"]')?.textContent).toContain('report.pdf');
  });

  it('⭐거절을 기다리는 사이 새 글을 쓰기 시작했으면 — 새 글은 그대로, 거절된 옛 글이 그 앞에 붙는다(덮어쓰지 않고 잃지도 않는다)', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/channel/token')) return new Response(JSON.stringify({ token: 't', backend_origin: 'https://api.test' }), { status: 200 });
      if (String(url).includes('/api/channel/deliver')) { await gate; return new Response('{}', { status: 500 }); }
      return new Response('{}', { status: 200 });
    }));
    await mount();
    await act(async () => { ws().drop(); });
    await act(async () => { typeInto('먼저 보낸 글'); });
    await act(async () => { (container.querySelector('[data-testid="channel-send"]') as HTMLButtonElement).click(); });
    await act(async () => { typeInto('그 사이 쓰는 새 글'); }); // typed while the request is still out
    await act(async () => { release(); });
    await settle();
    expect(box().value).toBe('먼저 보낸 글\n그 사이 쓰는 새 글');
    expect(container.querySelector('[data-testid="channel-send-failed"]')).not.toBeNull();
  });

  it('⭐상태 낱말은 칩 하나 — 연결 중에는 목록이 따로 «연결 중»을 말하지 않고, 토큰을 못 읽으면 칩이 «연결 중»이 아니라 «연결 끊김»이다', async () => {
    await mount();
    expect(container.querySelector('[data-testid="channel-messages"]')?.textContent ?? '').not.toContain('연결 중');
    expect(container.querySelector('[data-testid="channel-messages"]')?.textContent ?? '').not.toContain(C.empty);
    expect(status()?.textContent).toBe(C.statusConnecting);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    tokenOk = false;
    await mount();
    expect(status()?.textContent).toBe(C.statusDisconnected);
    expect(container.querySelector('[data-testid="channel-token-failed"]')).not.toBeNull();
  });

  it('⭐보내기가 받아지면 실패 띠 없이 칸이 비고, 빈 글이면 전송 단추가 꺼져 있다', async () => {
    await mount();
    await act(async () => { ws().drop(); });
    const send = () => container.querySelector('[data-testid="channel-send"]') as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    await act(async () => { typeInto('보낼 글'); });
    expect(send().disabled).toBe(false);
    await act(async () => { send().click(); });
    await settle();
    expect(container.querySelector('[data-testid="channel-send-failed"]')).toBeNull();
    expect(box().value).toBe('');
  });

  it('⭐토큰을 못 읽으면 «연결 중…»에 영영 머물지 않고 실패 띠 + 다시 시도(전엔 말없이 삼켰다)', async () => {
    tokenOk = false;
    await mount();
    expect(container.querySelector('[data-testid="channel-token-failed"]')?.textContent).toBe(C.connectFailed);
    expect(FakeWebSocket.instances).toHaveLength(0);
    tokenOk = true;
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.common.retry) as HTMLButtonElement;
    await act(async () => { retry.click(); });
    await settle();
    expect(container.querySelector('[data-testid="channel-token-failed"]')).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('답장 띠 — ↩ 누르면 미리보기 띠가 서고 ✕로 닫힌다', async () => {
    await mount();
    await act(async () => { ws().open(); ws().receive({ id: 'm1', sender_id: 'ag-1', sender_name: 'A', content: '이 글에 답장', ts: NOW }); });
    const reply = container.querySelector(`[data-testid="channel-message"] button[aria-label="${C.reply}"]`) as HTMLButtonElement;
    await act(async () => { reply.click(); });
    expect(container.querySelector('[data-testid="channel-reply-strip"]')?.textContent).toContain('이 글에 답장');
    await act(async () => { (container.querySelector(`[data-testid="channel-reply-strip"] button[aria-label="${C.cancelReply}"]`) as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="channel-reply-strip"]')).toBeNull();
  });

  it('agent_id가 없으면 틀 안에 빈 상태 문장 하나(제목은 그대로 위 막대)', async () => {
    search.value = '';
    await mount();
    expect(container.textContent).toContain(C.missingAgentId);
    expect(container.querySelector('[data-slot="ds-page-frame"]')?.getAttribute('data-width')).toBe('stream');
    expect(topBar.titles.length).toBeGreaterThan(0);
  });

  it('영어 문구가 있고 한국어와 같은 키를 갖는다', () => {
    expect(Object.keys(enMessages.channel).sort()).toEqual(Object.keys(koMessages.channel).sort());
  });
});
