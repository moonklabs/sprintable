// @vitest-environment jsdom
//
// story 4855 — selecting and copying chat text must not be blocked on web · Mac app · phone app.
// Real DOM (createRoot), the real menu; the clipboard is a spy. Each test names the failure it turns RED on.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble, INLINE_CODE_COPY_DELAY_MS, visibleMessageText } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({
    projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [],
  }),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

const message = (content: string): ChatMessage => ({
  id: 'm4855',
  memo_id: 'conv-1',
  created_by: 'agent-1',
  sender_name: 'Dev',
  sender_type: 'agent',
  sender_avatar_url: null,
  sender_runtime_type: null,
  content,
  attachments: [],
  created_at: '2026-07-20T00:00:00.000Z',
});

async function render(content: string, locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <ChatBubble message={message(content)} isMine={false} />
      </NextIntlClientProvider>,
    );
  });
}

const bubbleText = () => container.querySelector('[data-testid="chat-bubble-text"]') as HTMLElement;
/** the first text node of the bubble's text (the markdown wraps plain text in an element or not: do not depend on which) */
const firstTextNode = (): Text => {
  const walker = document.createTreeWalker(bubbleText(), NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text;
};
const textParent = (): Element => firstTextNode().parentElement!;
const menu = () => document.querySelector('[role="menu"]') as HTMLElement | null;
const menuLabels = () => Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());

function selectText(el: Node, from: number, to: number) {
  const textNode = el.nodeType === Node.TEXT_NODE ? el : (el.firstChild as Node);
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function contextMenuEvent(target: Element) {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
  act(() => { target.dispatchEvent(ev); });
  return ev;
}

beforeEach(() => {
  // jsdom has no layout, hence no `innerText`: the stand-in makes the PRODUCTION path (innerText first) run, not its textContent fallback
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      // what a browser does with `display:none`: not part of the text
      const clone = (this as HTMLElement).cloneNode(true) as HTMLElement;
      clone.querySelectorAll<HTMLElement>('*').forEach((n) => { if (n.style.display === 'none') n.remove(); });
      return clone.textContent ?? '';
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as { innerText?: string }).innerText;
});

describe('story 4855 — the menu copies the selection and the whole message', () => {
  it('a right click with text selected in this message offers «Copy selection» first, and it copies exactly the selection', async () => {
    await render('hello brave new world');
    selectText(firstTextNode(), 6, 11); // «brave»
    const ev = contextMenuEvent(bubbleText());
    expect(ev.defaultPrevented).toBe(true);
    expect(menuLabels()[1]).toBe('선택한 글 복사');
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('brave');
  });

  it('a selection dragged from this message into ANOTHER place is not offered as «Copy selection»', async () => {
    await render('hello brave new world');
    const other = document.createElement('p');
    other.textContent = 'elsewhere on the page';
    document.body.appendChild(other);
    const range = document.createRange();
    range.setStart(firstTextNode(), 6);
    range.setEnd(other.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    contextMenuEvent(bubbleText());
    expect(menuLabels()).not.toContain('선택한 글 복사');
    other.remove();
  });

  it('«Copy whole message» does not carry the bubble\'s «couldn\'t copy» notice, and keeps a code line\'s own leading spaces', async () => {
    vi.useFakeTimers();
    writeText.mockRejectedValue(new Error('refused'));
    document.execCommand = vi.fn().mockReturnValue(false);
    await render('use `npm test` now\n\n```\n  indented line\n```');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.click(); });
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(container.querySelector('[data-copy-ui]'), 'the notice is drawn').not.toBeNull();
    const notice = container.querySelector('[data-copy-ui]')!.textContent!;
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).not.toContain(notice);
    expect(copied).toContain('  indented line');
  });

  it('«Copy whole message» of a message that BEGINS with an indented code line keeps those spaces', async () => {
    await render('```\n  indented line\n```');
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    expect(writeText.mock.calls[0]![0]).toBe('  indented line');
  });

  it('the user\'s own text equal to the notice stays: only the bubble\'s control is left out of the copy', async () => {
    vi.useFakeTimers();
    writeText.mockRejectedValue(new Error('refused'));
    document.execCommand = vi.fn().mockReturnValue(false);
    const notice = (koMessages as { common: { copyFailedSelectManually: string } }).common.copyFailedSelectManually;
    await render(`${notice} use \`npm test\` now`);
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.click(); });
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(container.querySelector('[data-copy-ui]')).not.toBeNull();
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied.split(notice).length - 1, 'the user\'s one occurrence, not the control\'s').toBe(1);
    expect(copied.startsWith(notice)).toBe(true);
  });

  it('the same message on the page twice (the chat and its thread panel): each copy reads its OWN bubble', async () => {
    const m = message('first line\n\nsecond **bold** line');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <div id="chat"><ChatBubble message={m} isMine={false} /></div>
          <div id="thread"><ChatBubble message={m} isMine={false} /></div>
        </NextIntlClientProvider>,
      );
    });
    const inThread = container.querySelector('#thread [data-testid="chat-bubble-text"]') as HTMLElement;
    const walker = document.createTreeWalker(inThread, NodeFilter.SHOW_TEXT);
    selectText(walker.nextNode()!, 0, 5); // «first»
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { inThread.dispatchEvent(ev); });
    expect(menuLabels()).toContain('선택한 글 복사'); // the selection is in the thread's instance: found, not lost to the first instance with the same id
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    expect(writeText).toHaveBeenCalledWith('first');
  });

  it('with nothing selected the menu has no «Copy selection» (only the whole-message copy)', async () => {
    await render('hello brave new world');
    contextMenuEvent(bubbleText());
    expect(menuLabels()).toContain('메시지 전체 복사');
    expect(menuLabels()).not.toContain('선택한 글 복사');
  });

  it('a selection that is in ANOTHER place of the page is not offered (only this message\'s own selection)', async () => {
    await render('hello brave new world');
    const other = document.createElement('p');
    other.textContent = 'elsewhere on the page';
    document.body.appendChild(other);
    selectText(other.firstChild!, 0, 9);
    contextMenuEvent(bubbleText());
    expect(menuLabels()).not.toContain('선택한 글 복사');
    other.remove();
  });

  it('«Copy whole message» copies what is SEEN: code fence marks and bold marks are not in the clipboard', async () => {
    await render('**Run** this:\n\n```\nnpm test\n```');
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain('Run');
    expect(copied).toContain('npm test');
    expect(copied).not.toContain('```');
    expect(copied).not.toContain('**');
  });

  it('the labels are English in en', async () => {
    await render('hello brave new world', 'en');
    selectText(firstTextNode(), 0, 5);
    contextMenuEvent(bubbleText());
    expect(menuLabels()).toEqual(expect.arrayContaining(['Copy selection', 'Copy whole message']));
  });

  it('visibleMessageText: a folded report card (data-copy-source) copies the source; a «view full» control is not part of the text', () => {
    const host = document.createElement('div');
    host.id = 'msg-card';
    host.innerHTML = '<div data-testid="chat-bubble-text"><div data-copy-source="">summary lines<button data-copy-ui="">전문 보기</button></div></div>';
    document.body.appendChild(host);
    expect(visibleMessageText(host, 'FULL SOURCE')).toBe('FULL SOURCE');
    host.innerHTML = '<div data-testid="chat-bubble-text">hello<button data-copy-ui="">전문 보기</button></div>';
    expect(visibleMessageText(host, 'FULL SOURCE')).toBe('hello');
    host.remove();
  });

  it('a long press on the margin carries a surviving selection into the menu', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    selectText(firstTextNode(), 6, 11);
    const row = container.querySelector('#msg-m4855') as HTMLElement;
    act(() => {
      row.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 5, clientY: 40 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(600); });
    expect(menuLabels()).toContain('선택한 글 복사');
  });

  it('a copy that worked ends the «couldn\'t copy» notice of an earlier try', async () => {
    await render('hello brave new world');
    writeText.mockRejectedValueOnce(new Error('refused'));
    document.execCommand = vi.fn().mockReturnValue(false);
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    expect(container.querySelector('[role="alert"]'), 'the first try failed: notice shown').not.toBeNull();
    contextMenuEvent(bubbleText());
    await act(async () => { (document.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click(); });
    expect(container.querySelector('[role="alert"]'), 'the retry worked: notice gone').toBeNull();
  });

  it('the «⋯» button carries a selection that survived the tap', async () => {
    await render('hello brave new world');
    selectText(firstTextNode(), 6, 11);
    const btn = container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(menuLabels()).toContain('선택한 글 복사');
  });

  it('visibleMessageText falls back to the source when the bubble is not on the page', () => {
    expect(visibleMessageText(null, '**source**')).toBe('**source**');
  });
});

describe('story 4855 — the platform keeps the long press on the text; the «⋯» button opens the menu on touch', () => {
  it('a touch long press ON the text does not open our menu (the platform selection stays unobstructed)', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    const p = textParent();
    act(() => {
      p.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 40 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(900); });
    expect(menu()).toBeNull();
  });

  it('a long press on the text of a COMMAND box (not the plain bubble) is also left to the platform', async () => {
    vi.useFakeTimers();
    await render('/review the last change');
    const hit = Array.from(container.querySelectorAll('[data-chat-content] *')).find((n) => n.children.length === 0 && n.textContent?.includes('/review'));
    expect(hit, 'the command text is drawn').toBeDefined();
    act(() => {
      hit!.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 40 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(900); });
    expect(menu()).toBeNull();
  });

  it('a long press on the time line (the meta row) opens the menu', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    const time = container.querySelector('time') as HTMLElement;
    act(() => {
      time.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 80 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(600); });
    expect(menu()).not.toBeNull();
  });

  it('the approval chip\'s «view in approvals» / «assign approver» links are marked as controls (not part of the copied text)', () => {
    const src = readFileSync(path.join(__dirname, 'embed-card.tsx'), 'utf8');
    for (const key of ["tContent('submitGateLink')", "tChats('assignApproverAndSubmit')"]) {
      const at = src.indexOf(key);
      expect(at, key).toBeGreaterThan(0);
      expect(src.slice(Math.max(0, at - 420), at), `${key} link carries data-copy-ui`).toContain('data-copy-ui=""');
    }
  });

  it('a gate group is a card (data-copy-source): whole-message copy takes the source', () => {
    const src = readFileSync(path.join(__dirname, 'embed-group.tsx'), 'utf8');
    const gate = src.slice(src.indexOf('function GateGroup'), src.indexOf('artifact 그룹'));
    expect(gate).toContain('data-copy-source=""');
  });

  it('the press that opened the menu does not also click the reply-count button it ended on', async () => {
    vi.useFakeTimers();
    const onOpenThread = vi.fn();
    const m = { ...message('hello brave new world'), reply_count: 2 };
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatBubble message={m} isMine={false} onOpenThread={onOpenThread} />
        </NextIntlClientProvider>,
      );
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.hasAttribute('data-chat-meta') && b.textContent?.includes('2'))!;
    expect(btn, 'the reply-count button').toBeDefined();
    act(() => {
      btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 80 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(600); });
    expect(menu()).not.toBeNull();
    act(() => { btn.dispatchEvent(new TouchEvent('touchend', { bubbles: true })); });
    act(() => { btn.click(); });
    expect(onOpenThread, 'the click that follows the long press is swallowed').not.toHaveBeenCalled();
    act(() => { btn.click(); });
    expect(onOpenThread, 'the next real click works').toHaveBeenCalledTimes(1);
  });

  it('a long press whose click never comes (the platform took the gesture over) does not eat the NEXT tap on the reply-count button', async () => {
    vi.useFakeTimers();
    const onOpenThread = vi.fn();
    const m = { ...message('hello brave new world'), reply_count: 2 };
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatBubble message={m} isMine={false} onOpenThread={onOpenThread} />
        </NextIntlClientProvider>,
      );
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.hasAttribute('data-chat-meta') && b.textContent?.includes('2'))!;
    act(() => {
      btn.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 80 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(600); });
    expect(menu()).not.toBeNull();
    // no click follows: the gesture is cancelled
    act(() => { btn.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true })); });
    // the person touches the message TEXT next (a new gesture that the platform owns: no menu timer), then taps the button: neither may be eaten by the earlier long press
    act(() => {
      textParent().dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 30, clientY: 40 } as Touch] }));
    });
    act(() => { textParent().dispatchEvent(new TouchEvent('touchend', { bubbles: true })); });
    act(() => { btn.click(); });
    expect(onOpenThread, 'a click after a NEW touch is not eaten by an earlier unanswered long press').toHaveBeenCalledTimes(1);
  });

  it('a folded list of linked items («+N more») is a summary: whole-message copy takes the source, and its fold control is not text', () => {
    const src = readFileSync(path.join(__dirname, 'embed-group.tsx'), 'utf8');
    const list = src.slice(src.indexOf('function ConciseList'), src.indexOf('export function EmbedGroup'));
    expect(list).toContain("'data-copy-source': ''");
    expect(list).toMatch(/hiddenCount > 0 && !expanded/);
    const button = list.slice(list.indexOf('<button'), list.indexOf('</button>'));
    expect(button).toContain('data-copy-ui=""');
  });

  it('a touch long press OFF the text (the row\'s margin) still opens the menu', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    const row = container.querySelector('#msg-m4855') as HTMLElement;
    act(() => {
      row.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 5, clientY: 40 } as Touch] }));
    });
    act(() => { vi.advanceTimersByTime(600); });
    expect(menu()).not.toBeNull();
  });

  it('a touch the platform cancelled (touchcancel: it began a scroll) never opens the menu afterwards', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    const row = container.querySelector('#msg-m4855') as HTMLElement;
    act(() => {
      row.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 5, clientY: 40 } as Touch] }));
    });
    act(() => { row.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(900); });
    expect(menu()).toBeNull();
  });

  it('a bubble that leaves the page during a press does not open a menu (the timer ends with it)', async () => {
    vi.useFakeTimers();
    await render('hello brave new world');
    const row = container.querySelector('#msg-m4855') as HTMLElement;
    act(() => {
      row.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientX: 5, clientY: 40 } as Touch] }));
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => { root.unmount(); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the same long press delivered as a plain event without pointerType, on a coarse-pointer device, is also left to the platform', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
    await render('hello brave new world');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => { textParent().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('the touch «contextmenu» (the platform long press) on the text is left to the platform: not prevented, no menu', async () => {
    await render('hello brave new world');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    act(() => { textParent().dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('the «⋯» button exists on every message, is shown only on a touch (coarse) pointer, and opens the menu', async () => {
    await render('hello brave new world');
    const btn = container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('메시지 메뉴');
    expect(btn.className).toContain('hidden');
    expect(btn.className).toContain('touch:inline-flex');
    await act(async () => { btn.click(); });
    expect(menu()).not.toBeNull();
    expect(menuLabels()).toContain('메시지 전체 복사');
  });

  it('the «⋯» button is shown on a touch screen AND where nothing can hover (the ds `touch:` variant is both conditions), and the class generates the real media rule', async () => {
    await render('hello brave new world');
    const btn = container.querySelector('[data-testid="chat-bubble-menu-button"]') as HTMLButtonElement;
    const classes = btn.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('touch:inline-flex');
    // the class names are only text until Tailwind turns them into CSS: compile the button's own classes with the design system's own `touch` variant and read the media rule back
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const ds = readFileSync(join(process.cwd(), 'src/styles/design-system.css'), 'utf8');
    const variant = /@custom-variant touch \{[\s\S]*?\n\}/.exec(ds)?.[0];
    expect(variant, 'the touch variant is defined in design-system.css').toBeTruthy();
    const { compile } = await import('tailwindcss');
    const css = (await compile(`@tailwind utilities;\n${variant}`)).build(classes);
    expect(css).toMatch(/\.touch\\:inline-flex\s*\{\s*@media \(pointer: coarse\), \(hover: none\)\s*\{\s*display: inline-flex;/);
    // and the plain «hidden» comes BEFORE it (a later rule wins), so the media rule can show the button
    expect(css.indexOf('.hidden')).toBeGreaterThan(-1);
    expect(css.indexOf('.hidden')).toBeLessThan(css.indexOf('touch'));
  });
});

describe('story 4855 — a drag / double click on inline code or a link does not fire the one-click copy or a drag', () => {
  it('a plain click on inline code copies after the short wait', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.click(); });
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS - 10); });
    expect(writeText, 'not before the wait is over (a second click may still come)').not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(20); });
    expect(writeText).toHaveBeenCalledWith('npm test');
  });

  it('a click that ENDS a selection of part of the code does not overwrite the clipboard with the whole span', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    selectText(code.firstChild!, 0, 3);
    act(() => { code.click(); });
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('the click that ENDS a selection never copies, even if the selection is gone a moment later', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    selectText(code.firstChild!, 0, 3);
    act(() => { code.click(); });
    window.getSelection()?.removeAllRanges();
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a selection made inside the wait cancels the copy too', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.click(); });
    selectText(code.firstChild!, 4, 8);
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a TAP (touch) on inline code copies at once, inside the gesture (an iOS web view refuses a write after it)', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    act(() => { code.dispatchEvent(ev); });
    expect(writeText).toHaveBeenCalledWith('npm test'); // no timer advanced
  });

  it('a plain mouse-shaped click from a web view (no pointerType) on a coarse-pointer device is a tap: copies at once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
    expect(writeText).toHaveBeenCalledWith('npm test'); // no timer advanced
  });

  it('a click and then the Enter key copy ONCE', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => { code.click(); });
    await act(async () => { code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('a double click (detail 2: selects a word) does not copy', async () => {
    vi.useFakeTimers();
    await render('use `npm test` now');
    const code = container.querySelector('code[role="button"]') as HTMLElement;
    act(() => {
      code.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      code.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    });
    await act(async () => { vi.advanceTimersByTime(INLINE_CODE_COPY_DELAY_MS + 10); });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('the anchor is not draggable: a link drag does not take the place of a selection that runs over the link text', async () => {
    await render('see [the docs](https://example.com/docs) now');
    const a = container.querySelector('a[href="https://example.com/docs"]') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute('draggable')).toBe('false');
  });
});
