// @vitest-environment jsdom
//
// story #1969(2026-08-30) — inbox_items 기능 완전 은퇴로 story #2923(카디르 QA HIGH1·HIGH2,
// PR#3352 2026-08-22 처방)의 /api/inbox project_id 필터·gate_pending/inbox cross-source dedup
// 테스트는 대상 코드가 사라져 함께 걷었다.
// story #2923(P0-E AQ3, doc attention-audit-redesign-2923) — 「결재함=완전 목록 overflow·
// Attention GATE 앵커」. 예전엔 overflow 표시가 순수 텍스트라 캡(3~7) 초과분을 볼 방법이
// 없었다 — 이 스위트는 그 표시가 실제로 클릭 가능한 앵커(/inbox?tab=gates)로 동작하는지,
// overflow=0일 때는 그 앵커 자체가 서지 않는지를 고정한다.
// story #2923(P0-E AQ2, doc attention-audit-redesign-2923) — 개입유형(GATE/STEER/BLOCK/Q)
// compact 배지 배선. bucket 값이 실제로 ProofCapsule의 typeBadge prop까지 전달되는지 고정
// (배지 자체의 무채 스타일링은 proof-capsule.test.tsx에서 컴포넌트 단위로 이미 검증됨).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AttentionRow } from './attention-queue-view';
import type { AttentionQueueItem } from './derive-attention-queue';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

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

function beItem(overrides: Record<string, unknown> = {}) {
  return { kind: 'decision_needed', story_id: 'story-1', title: '기본 항목', ref: {}, entered_state_at: null, ...overrides };
}

// N개의 서로 다른 story_id를 가진 decision_needed 신호를 만든다 — cap(7) 초과분이 overflow로 잡힌다.
function manySignals(n: number) {
  return Array.from({ length: n }, (_, i) => beItem({ kind: 'needs_input', story_id: `s${i}` }));
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
  vi.resetModules();
  pushMock.mockReset();
});

async function mount(fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const { AttentionQueueView } = await import('./attention-queue-view');
  await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function mockGatePendingOnly() {
  return async (url: string) => {
    if (url.includes('/api/glance/attention')) {
      return {
        ok: true,
        json: async () => ({
          data: { items: [{ kind: 'gate_pending', story_id: 's1', title: '가격 콘솔', ref: {}, entered_state_at: null }] },
        }),
      };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  };
}

describe('AttentionQueueView — overflow anchor (story #2923 AQ3 + MEDIUM① GATE 정밀판정, 카디르 QA PR#3353)', () => {
  it('overflow에 GATE 버킷이 있으면 클릭 가능한 앵커가 뜨고, 클릭하면 /inbox?tab=gates로 이동한다', async () => {
    // needs_input 9건(전부 STEER, s0~s8) + gate_pending 1건(GATE, s9) — cap=7이라 뒤쪽(8·9번째,
    // s7·s8 STEER + gate_pending s9 GATE)이 overflow로 잘린다. cut에 GATE가 섞여 있어야 앵커.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return {
          ok: true,
          json: async () => ({
            data: { items: [...manySignals(9), beItem({ kind: 'gate_pending', story_id: 's9' })] },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { AttentionQueueView } = await import('./attention-queue-view');
    await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('나머지는'));
    expect(anchor).toBeTruthy();
    await act(async () => { anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).toHaveBeenCalledWith('/inbox?tab=gates');
  });

  // 카디르 QA MEDIUM①(PR#3353, 2026-08-22, 실 재현) — needs_input 10건→overflow 3, 전부
  // STEER(GATE 0)인데 예전엔 무조건 앵커가 떴다. 결재함(gates 탭)엔 GATE 3종만 있어 눌러도
  // 그 항목이 없었다 — bucket 정밀판정으로 이 조합에선 비내비게이션 텍스트로 폴백해야 한다.
  it('overflow가 전부 STEER(GATE 0)면 앵커 대신 기존 비내비게이션 텍스트로 폴백한다(재현: needs_input만 10건)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return { ok: true, json: async () => ({ data: { items: manySignals(10) } }) }; // cap=7 → overflow=3, 전부 STEER
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { AttentionQueueView } = await import('./attention-queue-view');
    await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('나머지는'));
    expect(anchor).toBeUndefined();
    // 앵커는 없지만 정직한 카운트 텍스트 자체는 여전히 뜬다(사라지지 않음 — 정보 손실 아님).
    expect(container.textContent).toContain('나머지는');
  });

  it('overflow = 0이면(캡 이내) 앵커·텍스트 둘 다 안 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return { ok: true, json: async () => ({ data: { items: manySignals(3) } }) }; // cap=7 미만 → overflow=0
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { AttentionQueueView } = await import('./attention-queue-view');
    await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('나머지는'));
    expect(anchor).toBeUndefined();
    expect(container.textContent).not.toContain('나머지는');
  });
});

describe('AttentionQueueView — typeBadge 배선 (story #2923 AQ2)', () => {
  it('gate_pending 신호(decision_needed·GATE 버킷)의 행에 "GATE" 배지가 뜬다', async () => {
    await mount(mockGatePendingOnly());
    expect(container.textContent).toContain('GATE');
  });
});

// story #3010(로드맵 P3, L5 대비) — kicker/empty body는 text-proof-faint(라이트 대비 미달)
// 대신 text-proof-ink-3.
describe('AttentionQueueView — 로드맵 P3 L5(faint 텍스트 대비 정정)', () => {
  it('kicker가 text-proof-ink-3를 쓰고 text-proof-faint는 안 쓴다', async () => {
    await mount(mockGatePendingOnly());
    const kicker = [...container.querySelectorAll('div')].find((d) => d.className.includes('uppercase') && d.className.includes('tracking-[0.12em]'));
    expect(kicker?.className).toContain('text-proof-ink-3');
    expect(container.querySelector('.text-proof-faint')).toBeNull();
  });

  it('빈 상태 empty body가 text-proof-ink-3를 쓰고 text-proof-faint는 안 쓴다', async () => {
    await mount(async (url: string) => {
      if (url.includes('/api/glance/attention')) return { ok: true, json: async () => ({ data: { items: [] } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    });
    const emptyBody = [...container.querySelectorAll('p')].find((p) => p.className.includes('text-[12.5px]'));
    expect(emptyBody?.className).toContain('text-proof-ink-3');
    expect(container.querySelector('.text-proof-faint')).toBeNull();
  });
});

// story #3010(로드맵 P3, L6, 유나 판정 2026-08-24) — 섹션 주 제목 h2는 font-editorial-heading
// (820 weight)로, 19px 크기는 유지.
describe('AttentionQueueView — 로드맵 P3 L6(섹션 제목 editorial weight)', () => {
  it('h2가 font-editorial-heading을 쓰고 text-[19px]는 유지한다', async () => {
    await mount(mockGatePendingOnly());
    const h2 = container.querySelector('h2');
    expect(h2?.className).toContain('font-editorial-heading');
    expect(h2?.className).toContain('text-[19px]');
    expect(h2?.className).not.toContain('font-extrabold');
  });
});

// story #3052(2984-S4) — "최근 변경" highlighted 행은 fill(bg-proof-citron/15 wash) 대신
// 헤어라인 좌측 액센트(border-l-proof-citron)를 쓴다. 색 신호(citron) 자체는 KEEP.
describe('AttentionRow — story #3052 헤어라인 액센트(citron fill 폐지)', () => {
  const item: AttentionQueueItem = {
    id: 'a1', kind: 'decision_needed', bucket: 'GATE', kindLabel: '게이트',
    proofState: 'amber', claim: '테스트 항목', actor: null,
    actionLabel: '검토', actionTone: 'primary', href: '/board?story=s1',
    enteredStateAtMs: null, sortKey: 0,
  };

  it('highlighted=true면 border-l-proof-citron을 쓰고 bg-proof-citron 채움은 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(<AttentionRow item={item} highlighted onNavigate={() => {}} />));
    });
    const row = container.querySelector('[role="button"]');
    expect(row?.className).toContain('border-l-proof-citron');
    expect(row?.className).not.toContain('bg-proof-citron');
  });

  it('highlighted=false면 border-l-transparent만 쓴다', async () => {
    await act(async () => {
      root.render(wrap(<AttentionRow item={item} highlighted={false} onNavigate={() => {}} />));
    });
    const row = container.querySelector('[role="button"]');
    expect(row?.className).toContain('border-l-transparent');
    expect(row?.className).not.toContain('border-l-proof-citron');
  });
});

// story #3099(DS·AA 후속, #3090과 동형 문법) — 「모두 처리됨」 빈 상태 문구(11px bold)가
// 라이트에서 text-proof-green AA 미달(3.49)이었다. 텍스트는 text-proof-ink로 중립화하고
// 색 신호는 ShieldCheck 아이콘 하나로 좁힌다(아이콘은 non-text 3:1 기준 PASS).
describe('AttentionQueueView — story #3099 빈 상태(모두 처리됨) 텍스트 AA 중립화', () => {
  it('빈 큐 안내 텍스트는 text-proof-ink이고, 색 신호는 ShieldCheck 아이콘에만 있다', async () => {
    await mount(async (url: string) => {
      if (url.includes('/api/glance/attention')) return { ok: true, json: async () => ({ data: { items: [] } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    });
    const label = [...container.querySelectorAll('div')].find((d) => d.textContent?.trim() === 'ALL CLEAR');
    expect(label).toBeTruthy();
    expect(label?.className).toContain('text-proof-ink');
    expect(label?.className).not.toContain('text-proof-green');
    const icon = label?.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-proof-green');
  });
});
