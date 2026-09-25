// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { BlockedUsersSection } from './blocked-users-section';
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

// story #2349 — 0명이면 절 자체를 안 그린다(standup-history-section.tsx 선례 재사용).
describe('BlockedUsersSection', () => {
  it('빈 목록이면 아무것도 안 그린다(절 자체가 없다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    // 마이크로태스크 큐 flush를 위해 한 틱 더
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
  });

  it('목록 fetch 실패면 아무것도 안 그린다(loading이 안 풀려도 조용히 실패)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe('');
  });

  it('1건 이상이면 절이 뜨고 이름을 resolve해 보여준다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('차단한 사용자 목록');
    expect(container.textContent).toContain('까심');
    expect(container.textContent).toContain('차단 해제');
  });

  it('차단 해제 클릭 → DELETE 성공 → 목록에서 즉시 빠진다(마지막 1건이면 절 전체가 사라진다)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      if (url === '/api/user-blocks/member-9' && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('까심');

    const unblockBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '차단 해제');
    expect(unblockBtn).not.toBeUndefined();
    await act(async () => {
      unblockBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });

  // story #3592(§17-20 ⑧·§22-18 동형) — 두 행이 실제로 다른 접근 이름을 낸다(보이는
  // 글자 「차단 해제」는 둘 다 같아도, 접근성 트리에서는 순번으로 갈린다).
  it('⭐#3592 — 2건이면 두 「차단 해제」 버튼의 접근 이름이 서로 다르고 각자 순번을 품는다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/user-blocks') {
        return {
          ok: true,
          json: async () => ({
            data: [
              { blocked_member_id: 'member-1', created_at: '2026-08-02T00:00:00Z' },
              { blocked_member_id: 'member-2', created_at: '2026-08-02T00:00:00Z' },
            ],
          }),
        };
      }
      if (url === '/api/team-members/member-1') return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      if (url === '/api/team-members/member-2') return { ok: true, json: async () => ({ data: { name: '유나' } }) };
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === '차단 해제');
    expect(buttons).toHaveLength(2);
    const names = buttons.map((b) => b.getAttribute('aria-label'));
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain('1번째');
    expect(names[0]).toContain('차단 해제');
    expect(names[1]).toContain('2번째');
    expect(names[1]).toContain('차단 해제');
  });

  // story #3608(유나 §22-18 ④-2, PO 確定 2026-09-07) — pending 中 "..."는 접근
  // 이름에도 그대로 들어가 "1번째 ..."가 됐다(#3592 발견분). 낱말("해제 중…")로
  // 바뀌었는지 검증 — aria-label이 있는가가 아니라 그 안에 "..." 0·"해제 중" 포함.
  it('⭐#3608 — 차단 해제 pending 中 접근 이름·보이는 글자에 "..." 0, "해제 중" 포함', async () => {
    let resolveDelete!: () => void;
    const deletePending = new Promise<void>((resolve) => { resolveDelete = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      if (url === '/api/user-blocks/member-9' && init?.method === 'DELETE') {
        await deletePending;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const unblockBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '차단 해제');
    await act(async () => {
      unblockBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(unblockBtn!.textContent).not.toContain('...');
    expect(unblockBtn!.textContent).toContain('해제 중');
    const ariaLabel = unblockBtn!.getAttribute('aria-label');
    expect(ariaLabel).not.toContain('...');
    expect(ariaLabel).toContain('해제 중');
    resolveDelete();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  });

  it('차단 해제 실패면 목록에 그대로 남고 에러 토스트가 뜬다', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/user-blocks') {
        return { ok: true, json: async () => ({ data: [{ blocked_member_id: 'member-9', created_at: '2026-08-02T00:00:00Z' }] }) };
      }
      if (url === '/api/team-members/member-9') {
        return { ok: true, json: async () => ({ data: { name: '까심' } }) };
      }
      if (url === '/api/user-blocks/member-9' && init?.method === 'DELETE') {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const unblockBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '차단 해제');
    await act(async () => {
      unblockBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('까심');
  });

  // [SID:4286 · 까디르 873bcf080] 이름 null(dev 41명)이나 조회 실패면 원시 UUID가 이름 칸에 나가던 것 — memberNameById(4646 한 벌) + 꼬리 규칙.
  describe('이름 칸 폴백([SID:4286])', () => {
    const IDS = ['3f2a9c10-aaaa-4bbb-8ccc-000000000001', '7b41e0d2-aaaa-4bbb-8ccc-000000000002', '9c83f4a7-aaaa-4bbb-8ccc-000000000003'];
    async function renderWith(members: Record<string, { ok: boolean; name?: string | null } | 'throw'>) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/user-blocks') {
          return { ok: true, json: async () => ({ data: Object.keys(members).map((id) => ({ blocked_member_id: id, created_at: '2026-09-25T00:00:00Z' })) }) };
        }
        const id = url.replace('/api/team-members/', '');
        const m = members[id];
        if (m === 'throw') throw new Error('network');
        if (!m || !m.ok) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ data: { name: m.name ?? null } }) };
      }));
      await act(async () => { root.render(wrap(<BlockedUsersSection />)); });
      for (let i = 0; i < 3; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    const rowTexts = () => Array.from(container.querySelectorAll('span.flex.items-center')).map((el) => el.textContent ?? '');

    it('이름 null → «이름 없는 구성원» · 조회 실패(!ok) → «알 수 없는 구성원» · 이름 칸에 UUID 0(꼬리 없음 — 겹치지 않음)', async () => {
      await renderWith({ [IDS[0]!]: { ok: true, name: null }, [IDS[1]!]: { ok: false } });
      expect(rowTexts()).toEqual([koMessages.common.memberUnnamed, koMessages.common.memberUnknown]);
      for (const id of IDS) expect(container.textContent).not.toContain(id.slice(0, 8));
    });

    it('조회가 던지면(네트워크) «알 수 없는 구성원» · 실명은 그대로', async () => {
      await renderWith({ [IDS[0]!]: 'throw', [IDS[1]!]: { ok: true, name: '까심' } });
      expect(rowTexts()).toEqual([koMessages.common.memberUnknown, '까심']);
    });

    it('이름 없는 사람 둘 → 두 행에만 «· ID 앞 8자» 꼬리(실명 행은 그대로)', async () => {
      await renderWith({ [IDS[0]!]: { ok: true, name: null }, [IDS[1]!]: { ok: true, name: null }, [IDS[2]!]: { ok: true, name: '까심' } });
      expect(rowTexts()).toEqual([
        `${koMessages.common.memberUnnamed} · ${IDS[0]!.slice(0, 8)}`,
        `${koMessages.common.memberUnnamed} · ${IDS[1]!.slice(0, 8)}`,
        '까심',
      ]);
    });
  });
});
