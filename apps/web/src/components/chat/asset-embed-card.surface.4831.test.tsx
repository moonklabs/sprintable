// @vitest-environment jsdom
//
// story 4831 — (이 카드는 `ownMessage` 인자가 있던 시절 내 메시지 위에서만 흰 글자를 썼다. 인자는 걷었고 모양은 하나다.) 내 메시지 말풍선은 밝은 틴트(bg-proof-blue-soft) + 어두운 ink(story #2921)다. 그 위의 자산 카드가 옛 «진한 brand 버블 위 화이트 카드»의 흰 글자 · 흰 반투명을
// 그대로 쓰면 라이트에서 이름 · 크기 글자가 안 보인다(develop에 있던 결함). 내 메시지 위에서도 일반 카드 표면(card)과 일반 글자색을 쓴다 — 흰색을 되살리면 빨강이다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

const { AssetEmbedCard } = await import('./asset-embed-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); fetchWithAuthMock.mockReset(); });

async function renderCard(found: boolean) {
  fetchWithAuthMock.mockResolvedValue(found
    ? { ok: true, json: async () => ({ data: { id: 'a1', name: 'plan.pdf', content_type: 'application/pdf', size_bytes: 10, project_id: null } }) }
    : { ok: false, status: 404, json: async () => ({}) });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <AssetEmbedCard entityId="a1" label="plan.pdf" />
    </NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container.innerHTML;
}

describe('AssetEmbedCard — 표면(story 4831 · 내 말풍선 위에서도 같다)', () => {
  it.each([[true, '찾은 자산'], [false, '찾지 못한 자산']])('%s — 흰 글자 · 흰 반투명 없이 일반 카드 클래스를 쓴다(%s)', async (found) => {
    const html = await renderCard(found);
    expect(html).not.toMatch(/(^|[\s"'])(?:[a-z-]+:)*text-white(?![\w-])/);
    expect(html).not.toMatch(/(?:bg|border)-white\//);
    expect(html).not.toMatch(/on-scrim|overlay-fill|overlay-line/);
    expect(html).toContain('border-border');
  });

  it('찾은 자산의 이름은 일반 글자색(text-foreground)이다', async () => {
    const html = await renderCard(true);
    expect(html).toContain('text-foreground');
  });
});
