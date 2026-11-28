// @vitest-environment jsdom
//
// story 5048 T0 AC4 · Two-Pass 2차 고침 — 폰(390)의 누르는 곳이 44 아래로 읽혔다: 「⋯」 메시지 메뉴 단추(32) · 상대 아바타(28 · 상대 프로필을 여는 누름). 눈에 보이는 크기는 그대로 두고
// 누름 «영역»만 넓힌다 — 단추 · 아바타 안에 투명한 띠(`aria-hidden`)를 두어 띠를 누르면 곧 그 단추를 누른 것이다(story #4888 활성화 칩과 같은 꼴). jsdom은 배치가 없어 «띠가 있고 · 몇 px 나가는가 · 누구 것인가»를 지킨다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] }) }));
vi.mock('next/image', () => ({ default: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} /> })); // eslint-disable-line @next/next/no-img-element
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
const message = (): ChatMessage => ({ id: 'm5048', memo_id: 'conv-1', created_by: 'member-2', sender_name: '친절', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, content: 'hello', attachments: [], created_at: '2026-07-20T00:00:00.000Z' });
async function render(isMine: boolean) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatBubble message={message()} isMine={isMine} /></NextIntlClientProvider>); });
}
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }))); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('[SID:5048] 누름 띠 — 눈에 보이는 크기는 그대로, 누름 영역만 44', () => {
  it('⭐「⋯」 메시지 메뉴 단추(32) 안에 투명 띠(사방 6px → 44)가 있다 — 띠는 단추의 것이고 읽는 도구에 안 보인다', async () => {
    await render(false);
    const btn = q('chat-bubble-menu-button')!; const hit = q('chat-bubble-menu-hit')!;
    expect(btn.className).toMatch(/(^|\s)h-8(\s|$)/); expect(btn.className).toMatch(/(^|\s)w-8(\s|$)/); // 그려진 크기 32 그대로(옮기지 않음)
    expect(btn.contains(hit)).toBe(true);
    expect(hit.getAttribute('aria-hidden')).toBe('true');
    expect(hit.className).toContain('-inset-1.5'); // 32 + 6 + 6 = 44
    expect(hit.className).toContain('absolute');
  });
  it('⭐상대 아바타(28 · 프로필을 여는 누름)는 터치에서만 사방 8px → 44 띠를 갖는다(마우스에선 숨김)', async () => {
    await render(false);
    const avatar = q('chat-bubble-avatar-hit')!;
    expect(avatar).not.toBeNull();
    const wrap = avatar.parentElement as HTMLElement;
    expect(wrap.getAttribute('role')).toBe('button');
    expect(wrap.className).toMatch(/(^|\s)relative(\s|$)/); // 띠의 기준 상자
    expect(avatar.className).toContain('-inset-2'); expect(avatar.className).toContain('hidden'); expect(avatar.className).toContain('touch:block');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });
  it('내 말풍선의 아바타는 누름이 아니라(role 없음) 띠도 없다', async () => {
    await render(true);
    expect(q('chat-bubble-avatar-hit')).toBeNull();
  });
});
