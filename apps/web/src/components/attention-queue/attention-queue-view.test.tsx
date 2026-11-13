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

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더 있어요'));
    expect(anchor).toBeTruthy();
    expect(anchor!.textContent).toContain('— 결재 대기는 결재함에서'); // 유나 CHANGES — 숨은 행에 게이트가 있으면 자리는 결재함
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

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더 있어요'));
    expect(anchor).toBeUndefined();
    // 앵커는 없지만 정직한 카운트 텍스트 자체는 여전히 뜬다(사라지지 않음 — 정보 손실 아님).
    expect(container.textContent).toContain('3건 더 있어요 — 처리되는 대로 여기 차례로 올라와요');
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

    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더 있어요'));
    expect(anchor).toBeUndefined();
    expect(container.textContent).not.toContain('더 있어요');
  });
});

describe('AttentionQueueView — typeBadge 배선 (story #2923 AQ2)', () => {
  it('gate_pending 신호(decision_needed·GATE 버킷)의 행에 "GATE" 배지가 뜬다', async () => {
    await mount(mockGatePendingOnly());
    expect(container.textContent).toContain('GATE');
  });
});

// story #3010(로드맵 P3, L5 대비) — the faint-text contrast rule lives on in the ds parts (4909 AC3 3단계): the empty body uses the quiet ds ink (text-ds-ink-3), never a «faint» colour; the old proof kicker is gone with the proof panel.
describe('AttentionQueueView — 로드맵 P3 L5(faint 텍스트 대비 정정) · ds 부품', () => {
  it('머리는 ds SectionHeader(h2 = 지금 개입할 것)이고 옛 proof 면 · kicker · faint 글자는 하나도 안 남는다', async () => {
    await mount(mockGatePendingOnly());
    const header = container.querySelector('[data-slot="ds-section-header"]');
    expect(header).toBeTruthy();
    expect(header!.querySelector('h2')?.textContent).toContain('지금 개입할 것');
    expect(container.querySelector('[class*="proof-"]')).toBeNull(); // not one proof token class on the screen
    expect(container.querySelector('.uppercase')).toBeNull();
    expect(header!.querySelector('h2')?.textContent).toContain('홈'); // the kicker word is kept (muted), not dropped
  });

  it('빈 상태 empty body가 조용한 ds 잉크(text-ds-ink-3)를 쓴다', async () => {
    await mount(async (url: string) => {
      if (url.includes('/api/glance/attention')) return { ok: true, json: async () => ({ data: { items: [] } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    });
    const emptyBody = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('모든 작업이 흐르고 있어요'));
    expect(emptyBody?.className).toContain('text-ds-ink-3');
    expect(container.querySelector('[class*="proof-"]')).toBeNull();
  });
});

// story #3010(로드맵 P3, L6) — the section title is ONE heading (single mount), now the ds SectionHeader's title (text-ds-card-title · semibold), not a hand-rolled editorial h2.
describe('AttentionQueueView — 로드맵 P3 L6(섹션 제목) · ds SectionHeader', () => {
  it('섹션 제목은 h2 하나이고 ds 카드 제목 글자를 쓴다', async () => {
    await mount(mockGatePendingOnly());
    expect(container.querySelectorAll('h2')).toHaveLength(1);
    const title = container.querySelector('h2 [class*="text-ds-card-title"]');
    expect(title?.className).toContain('text-ds-card-title');
    expect(title?.className).toContain('font-semibold');
  });
  it('건수 글은 «{N}건 · 로그 안 열고 판단» 그대로 머리 오른쪽에 있다(수 규칙 그대로 — 7로 자른 수)', async () => {
    await mount(async (url: string) => (url.includes('/api/glance/attention')
      ? { ok: true, json: async () => ({ data: { items: manySignals(9) } }) } : { ok: true, json: async () => ({ data: [] }) }));
    expect(container.querySelector('[data-slot="ds-section-header"]')?.textContent).toContain('7건 · 로그 안 열고 판단');
  });
});

// story #3052(2984-S4) — "최근 변경" highlighted rows use a left-edge accent (no fill wash); 4909 AC3 3단계: the same rule on the ds row — a left bar in the action colour, nothing painted over the row.
describe('AttentionRow — story #3052 왼쪽 막대(배경 채움 폐지) · ds ListRow', () => {
  const item: AttentionQueueItem = {
    id: 'a1', kind: 'decision_needed', bucket: 'GATE', kindLabel: '게이트',
    proofState: 'amber', claim: '테스트 항목', actor: null,
    actionLabel: '검토', actionTone: 'primary', href: '/board?story=s1',
    enteredStateAtMs: null, sortKey: 0,
  };
  const rowEl = () => container.querySelector('[data-testid="attention-row"]');

  it('highlighted=true면 border-l-ds-action을 쓰고 배경 채움은 안 쓴다', async () => {
    await act(async () => { root.render(wrap(<AttentionRow item={item} highlighted onNavigate={() => {}} />)); });
    expect(rowEl()?.className).toContain('border-l-ds-action');
    expect(rowEl()?.className).not.toMatch(/(^|\s)bg-ds-action/);
  });

  it('highlighted=false면 border-l-transparent만 쓴다', async () => {
    await act(async () => { root.render(wrap(<AttentionRow item={item} highlighted={false} onNavigate={() => {}} />)); });
    expect(rowEl()?.className).toContain('border-l-transparent');
    expect(rowEl()?.className).not.toContain('border-l-ds-action');
  });
});

// 4909 AC3 3단계 — the row is ONE real link: the old separate gate button went to the same place as the row, so it is gone; the browser's own gestures (new tab · ⌘-click) come with a real <a href>.
describe('AttentionRow — 4909 행 하나 = 진짜 링크', () => {
  const item: AttentionQueueItem = {
    id: 'a1', kind: 'decision_needed', bucket: 'GATE', kindLabel: '게이트',
    proofState: 'amber', claim: '테스트 항목', actor: null,
    actionLabel: '검토', actionTone: 'primary', href: '/board?story=s1',
    enteredStateAtMs: null, sortKey: 0,
  };
  const draw = async (it: AttentionQueueItem = item, onNavigate: (h: string) => void = (h) => pushMock(h)) => {
    await act(async () => { root.render(wrap(<AttentionRow item={it} highlighted={false} onNavigate={onNavigate} />)); });
  };
  const click = async (init: MouseEventInit) => {
    const a = container.querySelector('a')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    await act(async () => { a.dispatchEvent(ev); });
    return ev;
  };

  it('⭐행 안의 링크는 정확히 하나(진짜 <a href>)이고 단추는 없다 — 같은 곳으로 가는 두 번째 자리가 없다', async () => {
    await draw();
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('/board?story=s1');
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull(); // not a fake button either
    // the verb survives as the row's own words (not a control)
    expect(container.textContent).toContain('검토');
    expect(anchors[0]!.textContent).toBe('테스트 항목');
  });

  it('⭐일반 클릭은 앱 라우터로(push · 기본 동작 막음)', async () => {
    await draw();
    const ev = await click({});
    expect(pushMock).toHaveBeenCalledWith('/board?story=s1');
    expect(ev.defaultPrevented).toBe(true);
  });

  it.each([['⌘', { metaKey: true }], ['Ctrl', { ctrlKey: true }], ['Shift', { shiftKey: true }], ['Alt', { altKey: true }], ['가운데 단추', { button: 1 }]] as const)('⭐%s 클릭은 브라우저 기본에 맡긴다(push 0 · 기본 동작 그대로)', async (_n, init) => {
    await draw();
    const ev = await click(init);
    expect(pushMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('⭐href가 없으면 행은 정적이다 — 링크도 role도 없고 눌러도 아무 데도 안 간다(없는 라우트를 지어내지 않는다)', async () => {
    await draw({ ...item, href: null });
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.textContent).toContain('테스트 항목');
    await act(async () => { container.querySelector('[data-testid="attention-row"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('행은 «종류 칩 · 주장 한 줄 · mono 부제(종류 · 시간)»로 그려진다 — 칩은 상태 말(kindLabel) 그대로, 색은 톤으로', async () => {
    await draw({ ...item, enteredStateAtMs: Date.now() - 3 * 3600_000 });
    const chip = container.querySelector('[data-slot="ds-chip"]');
    expect(chip?.textContent).toContain('게이트');
    expect(chip?.getAttribute('data-tone')).toBe('needs-hand'); // amber
    const sub = container.querySelector('.truncate.font-mono'); // the row's second line (the chip is font-mono too, but never truncates)
    expect(sub?.textContent).toMatch(/^GATE · /);
    expect(container.querySelector('[data-slot="ds-list-row"]')).toBeTruthy();
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
    const label = [...container.querySelectorAll('div')].find((d) => d.textContent?.trim() === '안전');
    expect(label).toBeTruthy();
    expect(label?.className).toContain('text-ds-ink');
    expect(label?.className).not.toContain('text-ds-done');
    const icon = label?.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-ds-done');
  });
});

describe('AttentionQueueView — story #4382 BE 잘림 신호(truncated_kinds)', () => {
  async function mountWith(truncatedKinds: string[] | undefined) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        const data: Record<string, unknown> = { items: manySignals(10) };
        if (truncatedKinds) data['truncated_kinds'] = truncatedKinds;
        return { ok: true, json: async () => ({ data }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { AttentionQueueView } = await import('./attention-queue-view');
    await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  }

  it('⭐BE가 한 신호를 100건에서 잘랐으면 남은 수를 «3건 이상»으로만 말한다(정확한 수로 단정하지 않음)', async () => {
    await mountWith(['needs_input']);
    expect(container.textContent).toContain('3건 이상 더 있어요 — 처리되는 대로 여기 차례로 올라와요');
  });

  it('잘림이 없거나(빈 목록) 필드가 없으면(예전 BE) 예전 문장 그대로 «3건은»', async () => {
    await mountWith([]);
    expect(container.textContent).toContain('3건 더 있어요 — 처리되는 대로 여기 차례로 올라와요');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    vi.resetModules();
    await mountWith(undefined);
    expect(container.textContent).toContain('3건 더 있어요 — 처리되는 대로 여기 차례로 올라와요');
  });
});

describe('AttentionQueueView — story #4382 까디르 메모 ①(묶인 뒤 캡 이하여도 잘림은 보인다)', () => {
  it('⭐gate_pending 101행이 스토리 6개로 묶여 넘침 0이어도 BE가 잘랐으면 «더 있을 수 있어요»', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => beItem({ kind: 'gate_pending', story_id: `s${i % 6}`, title: `게이트 ${i % 6}` }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/glance/attention')) {
        return { ok: true, json: async () => ({ data: { items: rows, truncated_kinds: ['gate_pending'] } }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { AttentionQueueView } = await import('./attention-queue-view');
    await act(async () => { root.render(wrap(<AttentionQueueView projectId="proj-1" />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    // 유나 CHANGES — 숨은 게이트가 있으니(gate_pending 잘림) 자리는 결재함 · 단추.
    const anchor = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('더 있을 수 있어요'));
    expect(anchor?.textContent).toBe('더 있을 수 있어요 — 결재 대기는 결재함에서');
    expect(anchor?.querySelector('.break-keep')).not.toBeNull();
    expect(container.textContent).not.toContain('0건');
  });
});
