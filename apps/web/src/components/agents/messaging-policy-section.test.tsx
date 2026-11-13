// @vitest-environment jsdom
//
// story #3231 4라운드(카디르 QA) — 이 컴포넌트는 부모(workforce/[id]/page.tsx)의
// canEdit(생성자 OR org admin/owner — BE assert_agent_owner와 정합)로 이미 올바르게
// 게이트돼 있었다. 그런데 내부의 allowlist 후보 fetch가 org-admin 전용 org-members
// roster를 썼던 게 회귀 원인 — Member가 만든 에이전트는 그 생성자 본인도 403이라
// allowlist 후보를 못 봤다. assert_agent_owner와 동일 게이트의 agent 전용 후보
// 엔드포인트로 교체됐는지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { MessagingPolicySection } from './messaging-policy-section';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('MessagingPolicySection — allowlist 후보를 agent 전용 엔드포인트에서 받는다(story #3231 4라운드)', () => {
  it('원 org-members roster가 아니라 /api/agents/{id}/message-policy/candidates를 호출한다', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/agents/agent-1/message-policy') {
        return { ok: true, json: async () => ({ data: { mode: 'creator_only', allowlist: [] } }) };
      }
      if (url === '/api/agents/agent-1/message-policy/candidates') {
        return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-1', name: '멤버 하나' }] }) };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush();

    expect(calls).not.toContain('/api/org-members');
    expect(calls).toContain('/api/agents/agent-1/message-policy/candidates');
  });

  it('candidates가 403이어도(Member 생성자, 방어적 케이스) 크래시 없이 빈 목록으로 저하된다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/agents/agent-1/message-policy') {
        return { ok: true, json: async () => ({ data: { mode: 'creator_only', allowlist: [] } }) };
      }
      if (url === '/api/agents/agent-1/message-policy/candidates') {
        return { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush();

    // 크래시 없이 마운트 완료 — 섹션 헤더 텍스트가 실제로 뜬 것으로 확인.
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  });
});

// [SID:4286 · PO 12:06Z 같은 부류] 허용 목록 «구성원 추가» 고르기 목록 — 이메일 없이 이름만 그려, 이름 없는 사람이 둘이면 겹친 행에만 꼬리.
describe('MessagingPolicySection — 고르기 목록 이름 없는 둘([SID:4286])', () => {
  it('서로 다른 두 줄(«· ID 앞 8자»)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/agents/agent-1/message-policy') return { ok: true, json: async () => ({ data: { mode: 'list', allowlist: [] } }) };
      if (url === '/api/agents/agent-1/message-policy/candidates') {
        return { ok: true, json: async () => ({ data: [
          { id: 'a2000000-1111', user_id: 'u-a', name: null },
          { id: 'b3000000-2222', user_id: 'u-b', name: null },
        ] }) };
      }
      return { ok: false, json: async () => null };
    }));
    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush();
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('구성원 추가'));
    expect(addBtn).toBeTruthy();
    await act(async () => { addBtn!.click(); });
    const rows = Array.from(container.querySelectorAll('[data-row-name]')).map((x) => x.textContent);
    expect(rows).toContain('이름 없는 구성원 · a2000000');
    expect(rows).toContain('이름 없는 구성원 · b3000000');
  });
});

// story 4912 (C2b) — the card's face: DetailCard (ds Card), ds Banner for the org-wide warning, ds Chip for the creator, a remove control NAMED BY WHOSE ROW it is, ds Buttons; the radio-card keeps its radio semantics.
describe('MessagingPolicySection — card face (story 4912 · C2b)', () => {
  const calls: Array<{ url: string; method: string }> = [];
  function stub(mode: 'creator_only' | 'list' | 'org_wide', allowlist: string[] = []) {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/agents/agent-1/message-policy' && !init?.method) return { ok: true, json: async () => ({ data: { mode, allowlist } }) };
      if (url === '/api/agents/agent-1/message-policy/candidates') return { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-9', name: '멤버 하나' }, { id: 'm-2', user_id: 'u-8', name: '멤버 둘' }] }) };
      if (url.startsWith('/api/agents/agent-1/message-policy/allowlist/') && init?.method === 'DELETE') return { ok: true, json: async () => ({ data: { allowlist: [] } }) };
      return { ok: true, json: async () => ({ data: {} }) };
    }));
  }
  async function mount() {
    await act(async () => { root.render(wrap(<MessagingPolicySection agentId="agent-1" creatorUserId="u-1" />)); });
    await flush(); await flush();
  }
  const card = () => container.querySelector('[data-testid="agent-detail-card-messaging-policy"]') as HTMLElement;
  const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
  const S = koMessages.settings;

  it('⭐카드는 DetailCard(ds Card · bg-ds-surface) · 모드 고르기는 radiogroup/radio 그대로(고른 쪽 aria-checked · ds action 테두리)', async () => {
    stub('creator_only');
    await mount();
    expect(card().getAttribute('data-slot')).toBe('ds-card');
    expect(card().className).toContain('bg-ds-surface');
    expect(card().querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(radios()).toHaveLength(3);
    const on = radios().filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(on).toHaveLength(1);
    expect(on[0]!.className).toContain('border-ds-action');
    expect(radios().filter((r) => r.getAttribute('aria-checked') === 'false').every((r) => r.className.includes('border-ds-line'))).toBe(true);
  });

  it('⭐«조직 전체»를 고르면 ds Banner(주의 띠)가 뜨고 [저장]이 ds primary로 나타난다 — 옛 Alert · hero 단추가 아니다', async () => {
    stub('creator_only');
    await mount();
    await act(async () => { radios()[2]!.click(); });
    const banner = card().querySelector('[data-slot="ds-banner"]') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role'), 'the warning interrupts (the old Alert warning was role=alert)').toBe('alert');
    expect(banner.textContent).toContain(S.messagingOrgWideWarningTitle);
    const save = [...card().querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save)!;
    expect(save.className).toContain('bg-ds-action');
  });

  it('⭐«조직 전체» 경고 띠는 세 장 바로 아래 · [저장] «위»에 있다(고르는 순간 결과를 읽고 나서 저장하는 차례) — 순서를 되돌리면 RED (PO 11-13)', async () => {
    stub('creator_only');
    await mount();
    await act(async () => { radios()[2]!.click(); });
    const banner = card().querySelector('[data-slot="ds-banner"]') as HTMLElement;
    const save = [...card().querySelectorAll('button')].find((b) => b.textContent === koMessages.common.save)!;
    const lastRadio = radios()[2]!;
    // DOM order: the three cards → the warning → [저장]
    expect(lastRadio.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING, 'the warning follows the mode cards').toBeTruthy();
    expect(banner.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING, 'the [저장] follows the warning').toBeTruthy();
  });

  it('⭐지정 구성원 행의 빼기는 «삭제 · 이름»으로 이름이 붙는다(같은 «삭제» N개가 아니다) · 누르면 그 구성원만 DELETE · 만든 사람 행은 ds Chip', async () => {
    stub('list', ['m-1', 'm-2']);
    await mount();
    expect(card().querySelector('[data-slot="ds-chip"]')?.textContent).toBe(S.messagingCreatorBadge);
    const names = [...card().querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).filter((n) => n?.startsWith(koMessages.common.delete));
    expect(names).toEqual([`${koMessages.common.delete} · 멤버 하나`, `${koMessages.common.delete} · 멤버 둘`]);
    await act(async () => { (card().querySelector(`button[aria-label="${koMessages.common.delete} · 멤버 하나"]`) as HTMLElement).click(); });
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/agents/agent-1/message-policy/allowlist/m-1']);
  });

  it('⭐소스: ui/section-card · ui/alert · ui/badge · ui/button이 없고(토스트 훅만 예외) 옛 글자 · 색 토큰이 없다 — 되돌리면 RED', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'messaging-policy-section.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect([...src.matchAll(/from '@\/components\/ui\/([\w-]+)'/g)].map((m) => m[1])).toEqual(['toast']);
    expect(src).not.toMatch(/text-(muted-foreground|foreground|destructive|xs|sm|base|brand)\b|border-brand|bg-brand|bg-muted|border-border/);
    expect(src).not.toMatch(/variant="(hero|outline)"/);
    expect(src).toContain('<DetailCard');
  });

  it('⭐빼는 중에는 그 행의 빼기가 눌리지 않는다(DELETE가 나가 있는 동안 disabled · codex) — 끝나면 행이 사라진다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stub('list', ['m-1']);
    const base = (globalThis as { fetch: typeof fetch }).fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/agents/agent-1/message-policy/allowlist/') && init?.method === 'DELETE') { await gate; return { ok: true, json: async () => ({ data: { allowlist: [] } }) }; }
      return base(url, init);
    }));
    await mount();
    const rm = () => card().querySelector(`button[aria-label="${koMessages.common.delete} · 멤버 하나"]`) as HTMLButtonElement | null;
    await act(async () => { rm()!.click(); });
    expect(rm()!.disabled).toBe(true);
    await act(async () => { release(); });
    await flush(); await flush();
    expect(rm()).toBeNull();
  });
});

