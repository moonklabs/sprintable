// @vitest-environment jsdom
// story #4331 — 문서 보기의 «누르면 동작하는 자리»가 키보드로 닿는다 · 링크 카드 면 · 첨부 크기 줄.
// - 정상 첨부 카드: 진짜 `<button type="button">`(Tab 초점 · Enter/Space는 브라우저 기본 동작) · 이름 = 파일 이름 + 크기 · 아이콘 aria-hidden.
// - 토글 요약: role=button · tabindex 0 · aria-expanded · aria-controls(내용) · Enter/Space(요약 자체에 초점일 때만).
// - 부류 가드: 렌더러가 click을 거는 자리는 모두 button · a[href] · [role=button][tabindex=0](+ keydown)뿐.
// - 크기: 속성 없음 · 숫자 아님 → 크기 줄 없음 · 0 → «0 B» · 나머지 공용 formatFileSize(유나 17:38Z).
// - 일반 링크 카드: 첨부 카드와 같은 cardVariants subtle 면(손코딩 면 0).
// jsdom은 키로 click을 만들지 않고 계산된 색도 없다 — Enter/Space로 내려받기 · 두 테마 면 색은 유나 실빌드 몫(PR 본문).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ ws: 'ws-1', proj: 'proj-b' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchWithAuth: fetchWithAuthMock }));

import { DocContentRenderer, attachmentSizeLabel } from './doc-content-renderer';
import { cardVariants } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let clicked: string[];
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.getAttribute('href') ?? ''); });
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: { url: 'https://signed.test/report.pdf' } }) });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); });

async function render(content: string, opts: { format?: 'html' | 'markdown'; publicMode?: boolean } = {}) {
  const format = opts.format ?? 'html';
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DocContentRenderer
          content={format === 'markdown' ? `${content}\n` : content}
          contentFormat={format}
          publicMode={opts.publicMode}
          publicAttachmentLabel="로그인하면 볼 수 있어요"
          untitledEmbedLabel="제목 없음"
          embedNotFoundLabel="문서를 찾을 수 없어요"
          unsafeLinkLabel={koMessages.docs.embedLinkBlocked}
          unsafeFileLabel={koMessages.docs.attachFileBlocked}
          wikiLinkTargets={{}}
        />
      </NextIntlClientProvider>,
    );
  });
}
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
const FOCUSABLE = 'button, a[href], [tabindex]:not([tabindex="-1"]), input, select, textarea';

describe('정상 첨부 카드 = 진짜 button([SID:4331] AC1)', () => {
  it.each(['html', 'markdown'] as const)('자산 참조(%s): button 하나 · 초점 · 이름 = 파일 이름 + 크기 · 아이콘 aria-hidden · 누르면 서명 요청 한 번 → 새 탭', async (format) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await render('<div data-type="fileAttachment" data-filename="report.pdf" data-size="12" data-asset-id="as-1"></div>', { format });
    const card = container.querySelector('[data-type="fileAttachment"]') as HTMLElement;
    const buttons = card.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    const button = buttons[0] as HTMLButtonElement;
    expect(button.type).toBe('button');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('report.pdf 12 B');
    expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('report.pdf 12 B');
    expect([...button.querySelectorAll('svg')].map((s) => s.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
    expect(button.querySelector('p, div'), 'button 안에 블록 요소(p · div) 없음').toBeNull();
    await act(async () => { button.click(); });
    await flush();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(String(fetchWithAuthMock.mock.calls[0][0])).toContain('/api/attachments/sign?asset_id=as-1');
    expect(open).toHaveBeenCalledWith('https://signed.test/report.pdf', '_blank', 'noopener,noreferrer');
  });

  // PO 05:42Z — 명령형 DOM 템플릿 button도 디자인 Button의 클래스 토큰(초점 링 · 최소 크기 · 호버)을 입는다(손으로 적은 버튼 모양 0) · 면은 첨부 카드 면.
  it('첨부 button = 디자인 Button 토큰(초점 링 · 최소 크기) + 첨부 카드 면', async () => {
    await render('<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-asset-id="as-1"></div>');
    const button = container.querySelector('[data-type="fileAttachment"] button') as HTMLElement;
    const ghost = buttonVariants({ variant: 'ghost' }).split(/\s+/);
    for (const token of ['focus-visible:ring-3', 'focus-visible:ring-proof-citron', 'focus-visible:border-proof-citron', 'outline-none', 'min-h-11']) {
      expect(ghost, `버튼 토큰 원천에 ${token}`).toContain(token);
      expect(button.classList.contains(token), `${token} · ${button.className}`).toBe(true);
    }
    for (const cls of cardVariants({ surface: 'subtle', radius: 'compact' }).split(/\s+/)) expect(button.classList.contains(cls), `면 ${cls}`).toBe(true);
    expect(button.classList.contains('hover:bg-muted/40'), '손으로 적은 호버 0').toBe(false);
  });

  it('옛 data: 첨부: button을 누르면 임시 a[download] 한 번(현 동작 유지)', async () => {
    await render('<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-file-data="data:text/plain;base64,YWJj"></div>');
    const button = container.querySelector('[data-type="fileAttachment"] button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('a.txt 3 B');
    act(() => { button.click(); });
    expect(clicked).toEqual(['data:text/plain;base64,YWJj']);
  });

  it.each([
    ['공개 보기', 'data:text/plain;base64,YWJj', true],
    ['열 수 없는 첨부(javascript:)', 'javascript:alert(1)', false],
  ] as const)('%s: button · 초점 가능한 것 0(누를 것이 없음 · 회귀 대조)', async (_label, value, publicMode) => {
    await render(`<div data-type="fileAttachment" data-filename="a.pdf" data-size="10" data-file-data="${value.replace(/"/g, '&quot;')}"></div>`, { publicMode });
    const card = container.querySelector('[data-type="fileAttachment"]') as HTMLElement;
    expect(card.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(card.textContent).toContain('a.pdf');
  });
});

describe('토글 요약 = 버튼 의미 + 펼침 상태([SID:4331] AC1 같은 부류)', () => {
  const TOGGLE = '<div data-type="toggleBlock" data-open="false"><div data-type="toggleSummary"><p>요약 <a href="https://example.com/x">링크</a></p></div><div data-type="toggleContent"><p>내용</p></div></div>';

  it('role=button · tabindex 0 · aria-expanded false → 누르면 true · aria-controls = 내용 id', async () => {
    await render(TOGGLE);
    const summary = container.querySelector('[data-type="toggleSummary"]') as HTMLElement;
    const content = container.querySelector('[data-type="toggleContent"]') as HTMLElement;
    const block = container.querySelector('[data-type="toggleBlock"]') as HTMLElement;
    expect(summary.getAttribute('role')).toBe('button');
    expect(summary.tabIndex).toBe(0);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(content.id).not.toBe('');
    expect(summary.getAttribute('aria-controls')).toBe(content.id);
    act(() => { summary.click(); });
    expect(block.getAttribute('data-open')).toBe('true');
    expect(summary.getAttribute('aria-expanded')).toBe('true');
  });

  it('요약에 초점일 때 Enter · Space로 열고 닫음 · 안의 링크에서 누른 Enter는 링크 몫(토글 안 함)', async () => {
    await render(TOGGLE);
    const summary = container.querySelector('[data-type="toggleSummary"]') as HTMLElement;
    const block = container.querySelector('[data-type="toggleBlock"]') as HTMLElement;
    const press = (target: HTMLElement, key: string) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(ev); });
      return ev;
    };
    const enter = press(summary, 'Enter');
    expect(block.getAttribute('data-open')).toBe('true');
    expect(enter.defaultPrevented).toBe(true);
    press(summary, ' ');
    expect(block.getAttribute('data-open')).toBe('false');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    const link = summary.querySelector('a') as HTMLElement;
    const fromLink = press(link, 'Enter');
    expect(block.getAttribute('data-open')).toBe('false');
    expect(fromLink.defaultPrevented).toBe(false);
    press(summary, 'a');
    expect(block.getAttribute('data-open')).toBe('false');
  });

  it('토글 둘 · 렌더러 둘이어도 내용 id가 겹치지 않음', async () => {
    await render(TOGGLE + TOGGLE);
    const ids = [...container.querySelectorAll('[data-type="toggleContent"]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('부류 가드 — click을 거는 자리는 키보드로 닿는 요소뿐([SID:4331] AC1 전수)', () => {
  it('모든 블록 종류 한 판: click 대상 = button · a[href] · [role=button][tabindex=0](+ keydown)', async () => {
    const targets: Array<{ el: Element; type: string }> = [];
    const orig = EventTarget.prototype.addEventListener;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if ((type === 'click' || type === 'keydown') && this instanceof Element && container.contains(this)) targets.push({ el: this, type });
      return orig.call(this, type, listener, options);
    });
    await render([
      '<pre><code class="language-ts">const a = 1;</code></pre>',
      '<div data-type="embedBlock" data-url="https://example.com/page"></div>',
      '<div data-type="fileAttachment" data-filename="report.pdf" data-size="12" data-asset-id="as-1"></div>',
      '<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-file-data="data:text/plain;base64,YWJj"></div>',
      '<div data-type="toggleBlock" data-open="false"><div data-type="toggleSummary"><p>요약</p></div><div data-type="toggleContent"><p>내용</p></div></div>',
      '<p><span data-type="wikiLink" data-slug="doc-a" data-title="문서 A">[[문서 A]]</span></p>',
    ].join(''));
    const clickTargets = targets.filter((t) => t.type === 'click').map((t) => t.el);
    expect(clickTargets.length, '양성 대조: 첨부 · 토글 등 click이 실제로 걸렸다').toBeGreaterThanOrEqual(3);
    for (const el of clickTargets) {
      const ok = el.tagName === 'BUTTON'
        || (el.tagName === 'A' && el.hasAttribute('href'))
        || (el.getAttribute('role') === 'button' && el.getAttribute('tabindex') === '0' && targets.some((t) => t.el === el && t.type === 'keydown'));
      expect(ok, el.outerHTML.slice(0, 120)).toBe(true);
    }
  });
});

describe('첨부 크기 줄([SID:4331] AC3 · 유나 17:38Z)', () => {
  it('attachmentSizeLabel: 없음 · 빈 글자 · 숫자 아님 · 음수 → 줄 없음 · 0 → «0 B» · 12 → «12 B» · 1536 → «1.5 KB» · 2 MB', () => {
    expect(attachmentSizeLabel(null)).toBe('');
    expect(attachmentSizeLabel('')).toBe('');
    expect(attachmentSizeLabel('  ')).toBe('');
    expect(attachmentSizeLabel('abc')).toBe('');
    expect(attachmentSizeLabel('-5')).toBe('');
    expect(attachmentSizeLabel('0')).toBe('0 B');
    expect(attachmentSizeLabel('12')).toBe('12 B');
    expect(attachmentSizeLabel('1536')).toBe('1.5 KB');
    expect(attachmentSizeLabel('2097152')).toBe('2.0 MB');
  });

  it.each([
    ['속성 없음', '', 'report.pdf'],
    ['숫자 아님', ' data-size="abc"', 'report.pdf'],
    ['빈 글자', ' data-size=""', 'report.pdf'],
    ['0(진짜 빈 파일)', ' data-size="0"', 'report.pdf 0 B'],
    ['12바이트(예전 «0.0 KB»)', ' data-size="12"', 'report.pdf 12 B'],
  ] as const)('%s → 이름 %j · 크기 줄은 알 때만', async (_label, sizeAttr, name) => {
    await render(`<div data-type="fileAttachment" data-filename="report.pdf"${sizeAttr} data-asset-id="as-1"></div>`);
    const button = container.querySelector('[data-type="fileAttachment"] button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe(name);
    const lines = [...button.querySelectorAll(':scope > span > span')].map((s) => s.textContent);
    expect(lines).toEqual(name === 'report.pdf' ? ['report.pdf'] : ['report.pdf', name.slice('report.pdf '.length)]);
    expect(button.textContent).not.toContain('0.0 KB');
  });
});

describe('일반 링크 카드 면 = 첨부 카드와 같은 subtle 면([SID:4331] AC2)', () => {
  it('cardVariants subtle/compact 클래스 전부 · 손코딩 면(border-border · bg-muted/20) 0', async () => {
    await render('<div data-type="embedBlock" data-url="https://example.com/page"></div>');
    const a = container.querySelector('[data-type="embedBlock"] a') as HTMLAnchorElement;
    // 면(테두리 · 배경 · 모서리)만 대조 — 글자색은 4316 결정대로 brand(cn이 card-foreground를 덮음).
    const surfaceOnly = cardVariants({ surface: 'subtle', radius: 'compact' }).split(/\s+/).filter((cls) => !cls.startsWith('text-'));
    expect(surfaceOnly.length).toBeGreaterThan(0);
    for (const cls of surfaceOnly) expect(a.classList.contains(cls), `${cls} · ${a.className}`).toBe(true);
    // 예전 손코딩 `rounded-xl border border-border bg-muted/20` — rounded-xl · border는 subtle 면에도 있어 가르는 표지는 이 둘.
    for (const cls of ['border-border', 'bg-muted/20']) expect(a.classList.contains(cls), `손코딩 ${cls}`).toBe(false);
    await render('<div data-type="fileAttachment" data-filename="a.txt" data-size="3" data-asset-id="as-1"></div>');
    const button = container.querySelector('[data-type="fileAttachment"] button') as HTMLElement;
    const surface = cardVariants({ surface: 'subtle', radius: 'compact' }).split(/\s+/);
    expect(surface.every((cls) => button.classList.contains(cls)), '첨부 카드도 같은 면').toBe(true);
  });
});

// 유나 production 빌드 대비(4712 CHANGES) — 첨부 크기 줄 `text-xs opacity-60`은 라이트 4.37:1(12px라 4.5 미달)이고 ghost Button의 font-medium을
// 물려받았다 → `text-xs font-normal text-muted-foreground`(«문서를 찾을 수 없어요» 둘째 줄과 같은 모양). 같은 카드 면의 페이지 임베드 slug 줄도 같은 처방.
describe('첨부 크기 줄 · 임베드 slug 줄 대비([SID:4331] 유나 CHANGES)', () => {
  const lineClass = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/);
  it('첨부 크기 줄 = text-xs font-normal text-muted-foreground · opacity 0', async () => {
    await render('<div data-type="fileAttachment" data-filename="report.pdf" data-size="12" data-asset-id="as-1"></div>');
    const sizeLine = [...container.querySelectorAll('[data-type="fileAttachment"] button span span')].find((el) => el.textContent === '12 B');
    expect(lineClass(sizeLine)).toEqual(expect.arrayContaining(['text-xs', 'font-normal', 'text-muted-foreground']));
    expect(lineClass(sizeLine).some((c) => c.startsWith('opacity-'))).toBe(false);
  });

  it('페이지 임베드 slug 줄도 같은 처방', async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DocContentRenderer content='<div data-page-embed data-title="살아 있는 문서" data-slug="design-doc"></div>' contentFormat="html" untitledEmbedLabel="제목 없음" embedNotFoundLabel="문서를 찾을 수 없어요" unsafeLinkLabel={koMessages.docs.embedLinkBlocked} unsafeFileLabel={koMessages.docs.attachFileBlocked} wikiLinkTargets={{ 'design-doc': 'design-doc' }} />
        </NextIntlClientProvider>,
      );
    });
    const slugLine = [...container.querySelectorAll('[data-page-embed] p')].find((p) => p.textContent === '/design-doc');
    expect(slugLine, 'slug 줄').toBeTruthy();
    expect(lineClass(slugLine)).toEqual(expect.arrayContaining(['text-xs', 'font-normal', 'text-muted-foreground']));
    expect(lineClass(slugLine).some((c) => c.startsWith('opacity-'))).toBe(false);
  });
});

