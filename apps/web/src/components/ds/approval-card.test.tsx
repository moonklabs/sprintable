// @vitest-environment jsdom
// UI-3(a9d56577) — ds ApprovalCard 회귀가드: 정보(라벨 · 제목 · 요청자 · 재료 · 위험 · 알림 · 오류) · 상태(대기 4시점 · 결과 5종 · 불러오는 중/없음/오류) · 내 손 필요만 호박 막대 + 읽히는 이름.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApprovalActions, ApprovalCard, ApprovalReason, type ApprovalState } from './approval-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
async function render(n: ReactNode) { await act(async () => { root.render(n); }); }
const card = () => container.querySelector('[data-slot="ds-approval-card"]') as HTMLElement;

function C(props: Partial<React.ComponentProps<typeof ApprovalCard>> & { state: ApprovalState }) {
  return <ApprovalCard label="결재 요청" title="결제 수단 두 개 추가" {...props} />;
}

describe('ds ApprovalCard — 정보', () => {
  it('⭐라벨 · 제목 · 요청자 · 결정 재료가 한 카드에 실린다', async () => {
    await render(<C requester="요청: 미르코" state={{ kind: 'resolved', resolution: 'approved', statusLabel: '허용됨' }}>무엇을 어떻게 바꾸나 요약</C>);
    expect(card().textContent).toContain('결재 요청');
    expect(card().textContent).toContain('결제 수단 두 개 추가');
    expect(card().textContent).toContain('요청: 미르코');
    expect(card().textContent).toContain('무엇을 어떻게 바꾸나 요약');
  });

  it('⭐제목은 onTitleClick이 있을 때만 단추 — 누르면 호출', async () => {
    const onTitleClick = vi.fn();
    await render(<C state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    expect(card().querySelector('button')).toBeNull();
    await render(<C onTitleClick={onTitleClick} state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    const b = card().querySelector('button')!;
    expect(b.textContent).toBe('결제 수단 두 개 추가');
    await act(async () => { b.click(); });
    expect(onTitleClick).toHaveBeenCalledTimes(1);
  });

  it('⭐제목은 머리글이다(기본 h3 · level로 바꿈) — 단추여도 머리글 안에 든다', async () => {
    await render(<C state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    expect(card().querySelector('h3')!.textContent).toBe('결제 수단 두 개 추가');
    await render(<C level={2} onTitleClick={() => {}} state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    expect(card().querySelector('h2 button')!.textContent).toBe('결제 수단 두 개 추가');
    expect(card().querySelector('h3')).toBeNull();
  });

  it('⭐제목 단추는 폰(coarse)에서 누름 영역 44를 지킨다 — min-h-0으로 지우지 않는다', async () => {
    await render(<C onTitleClick={() => {}} state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    const cls = card().querySelector('h3 button')!.className;
    expect(cls).toContain('touch:min-h-ds-touch');
    expect(cls).toContain('touch:min-w-ds-touch');
    expect(cls).not.toMatch(/(^|\s)min-h-0(\s|$)/);
  });

  it('⭐위험 표시는 아이콘 + 글, 대기 중에만 — 결과 카드에는 안 나온다', async () => {
    await render(<C risk={{ level: 'high', label: '고위험' }} state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    const chip = card().querySelector('[data-risk="high"]') as HTMLElement;
    expect(chip.textContent).toBe('고위험');
    expect(chip.querySelector('[data-icon="warning"]')).not.toBeNull();
    await render(<C risk={{ level: 'high', label: '고위험' }} state={{ kind: 'resolved', resolution: 'approved', statusLabel: '허용됨' }} />);
    expect(card().querySelector('[data-risk]')).toBeNull();
  });

  it('알림(논의 요청 등)은 대기 중에만 · 오류는 role=alert + error 아이콘', async () => {
    await render(<C notice="논의가 요청됨" error="보내지 못했어요" state={{ kind: 'pending', view: 'readonly', note: 'n' }} />);
    expect(card().textContent).toContain('논의가 요청됨');
    const alert = card().querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('보내지 못했어요');
    expect(alert.querySelector('[data-icon="error"]')).not.toBeNull();
    await render(<C notice="논의가 요청됨" state={{ kind: 'resolved', resolution: 'rejected', statusLabel: '거부됨' }} />);
    expect(card().textContent).not.toContain('논의가 요청됨');
  });
});

describe('ds ApprovalCard — 대기', () => {
  it('⭐내 손이 필요한 대기(act)만 호박 막대 + 안 보이는 이름 — 그 밖의 상태에는 막대가 없다', async () => {
    await render(<C state={{ kind: 'pending', view: 'act', needsHandLabel: '내 손이 필요', actions: <button type="button">허용</button> }} />);
    expect(card().className).toContain('border-l-ds-needs-hand-bar');
    expect(card().querySelector('.sr-only')!.textContent).toBe('내 손이 필요');
    expect(card().textContent).toContain('허용');
    for (const state of [
      { kind: 'pending', view: 'waiting', waitingOn: '미르코 님의 결재를 기다려요' },
      { kind: 'pending', view: 'readonly', note: '읽기 전용' },
      { kind: 'resolved', resolution: 'approved', statusLabel: '허용됨' },
      { kind: 'loading', loadingLabel: '불러오는 중' },
    ] as ApprovalState[]) {
      await render(<C state={state} />);
      expect(card().className, state.kind).not.toContain('border-l-ds-needs-hand-bar');
      expect(card().querySelector('.sr-only'), state.kind).toBeNull();
    }
  });

  it('요청자 · 관찰자 대기: 누구를 기다리는지 + (요청자만) 넘기는 행동 하나', async () => {
    await render(<C state={{ kind: 'pending', view: 'waiting', waitingOn: '미르코 님의 결재를 기다려요', action: <button type="button">다른 곳에서 결재받기</button> }} />);
    expect(card().textContent).toContain('미르코 님의 결재를 기다려요');
    expect(card().querySelector('[data-icon="schedule"]')).not.toBeNull();
    expect(card().querySelector('button')!.textContent).toBe('다른 곳에서 결재받기');
    await render(<C state={{ kind: 'pending', view: 'waiting', waitingOn: '미르코 님의 결재를 기다려요' }} />);
    expect(card().querySelector('button')).toBeNull();
  });

  it('위임으로 밀려난 · 권한 없는 대기: 행동 없이 이유 한 줄', async () => {
    await render(<C state={{ kind: 'pending', view: 'readonly', note: '다른 결재자에게 넘어갔어요' }} />);
    expect(card().textContent).toContain('다른 결재자에게 넘어갔어요');
    expect(card().querySelector('button')).toBeNull();
  });
});

describe('ds ApprovalCard — 결과', () => {
  it('⭐결과 여섯 종이 아이콘 + 글로 말한다: 허용됨 done · 거부됨 failed · 자동 통과/보류/취소/만료 중립', async () => {
    const want = {
      approved: ['check_circle', 'text-ds-done'], rejected: ['cancel', 'text-ds-failed'], auto_passed: ['info', 'text-ds-ink-2'], held: ['do_not_disturb_on', 'text-ds-ink-2'], voided: ['block', 'text-ds-ink-2'], expired: ['schedule', 'text-ds-ink-2'],
    } as const;
    for (const [res, [icon, cls]] of Object.entries(want)) {
      await render(<C state={{ kind: 'resolved', resolution: res as keyof typeof want, statusLabel: `상태 ${res}` }} />);
      const p = card().querySelector(`[data-resolution="${res}"]`) as HTMLElement;
      expect(p.textContent, res).toBe(`상태 ${res}`);
      expect(p.querySelector(`[data-icon="${icon}"]`), res).not.toBeNull();
      expect(p.className, res).toContain(cls);
    }
  });

  it('⭐자동 통과는 사람이 허용한 것처럼 보이지 않는다 — approved와 아이콘이 다르고 done 색이 아니다', async () => {
    await render(<C state={{ kind: 'resolved', resolution: 'auto_passed', statusLabel: '자동 통과' }} />);
    const p = card().querySelector('[data-resolution="auto_passed"]') as HTMLElement;
    expect(p.querySelector('[data-icon="check_circle"]')).toBeNull();
    expect(p.className).not.toContain('text-ds-done');
    expect(p.textContent).toBe('자동 통과');
  });

  it('처리자 · 사유 · 결과 뒤 행동(되돌리기)이 실린다', async () => {
    await render(<C state={{ kind: 'resolved', resolution: 'rejected', statusLabel: '거부됨', by: '카디르 님이 처리', note: '사유: 범위 밖', extra: <button type="button">되돌리기</button> }} />);
    expect(card().textContent).toContain('카디르 님이 처리');
    expect(card().textContent).toContain('사유: 범위 밖');
    expect(card().querySelector('button')!.textContent).toBe('되돌리기');
  });
});

describe('ds ApprovalCard — 불러오기', () => {
  it('불러오는 중은 role=status + 이름, aria-busy · 없음/오류는 글 한 줄', async () => {
    await render(<C state={{ kind: 'loading', loadingLabel: '결재를 불러오는 중' }} />);
    expect(card().querySelector('[role="status"]')!.getAttribute('aria-label')).toBe('결재를 불러오는 중');
    expect(card().querySelector('[aria-busy="true"]')).not.toBeNull();
    await render(<C state={{ kind: 'not-found', message: '결재를 찾지 못했어요' }} />);
    expect(card().textContent).toContain('결재를 찾지 못했어요');
    expect(card().textContent).not.toContain('결제 수단 두 개 추가');
    await render(<C state={{ kind: 'error', message: '불러오지 못했어요' }} />);
    expect(card().textContent).toContain('불러오지 못했어요');
  });
});

describe('ApprovalActions · ApprovalReason', () => {
  it('⭐허용 = 주 · 거부 = 보조(한 줄에 강조 하나) · 누르면 각 콜백', async () => {
    const a = vi.fn(); const r = vi.fn();
    await render(<ApprovalActions approveLabel="허용" rejectLabel="거부" onApprove={a} onReject={r} />);
    const [ok, no] = [...container.querySelectorAll('button')];
    expect(ok!.className).toMatch(/(^|\s)bg-ds-action(\s|$)/);
    expect(no!.className).not.toMatch(/(^|\s)bg-ds-action(\s|$)/);
    await act(async () => { ok!.click(); });
    await act(async () => { no!.click(); });
    expect(a).toHaveBeenCalledTimes(1);
    expect(r).toHaveBeenCalledTimes(1);
  });

  it('⭐처리 중인 쪽만 불러오는 중이고 다른 쪽은 눌리지 않는다 · 처리 중엔 두 번 눌러도 한 번만', async () => {
    const a = vi.fn(); const r = vi.fn();
    await render(<ApprovalActions approveLabel="허용" rejectLabel="거부" onApprove={a} onReject={r} busy="approve" />);
    const [ok, no] = [...container.querySelectorAll('button')];
    expect(ok!.getAttribute('aria-busy')).toBe('true');
    expect(no!.hasAttribute('disabled')).toBe(true);
    await act(async () => { ok!.click(); no!.click(); });
    expect(a).not.toHaveBeenCalled();
    expect(r).not.toHaveBeenCalled();
  });

  it('거부를 처리 중이면 허용이 눌리지 않는다(대칭)', async () => {
    const a = vi.fn();
    await render(<ApprovalActions approveLabel="허용" rejectLabel="거부" onApprove={a} onReject={() => {}} busy="reject" />);
    const [ok, no] = [...container.querySelectorAll('button')];
    expect(no!.getAttribute('aria-busy')).toBe('true');
    expect(ok!.hasAttribute('disabled')).toBe(true);
    await act(async () => { ok!.click(); });
    expect(a).not.toHaveBeenCalled();
  });

  it('disabled면 둘 다 눌리지 않는다 · 보조 행동이 뒤에 붙는다', async () => {
    await render(<ApprovalActions approveLabel="허용" rejectLabel="거부" onApprove={() => {}} onReject={() => {}} disabled><button type="button">논의 요청</button></ApprovalActions>);
    const [ok, no, more] = [...container.querySelectorAll('button')];
    expect(ok!.hasAttribute('disabled') && no!.hasAttribute('disabled')).toBe(true);
    expect(more!.textContent).toBe('논의 요청');
  });

  it('사유 칸: 보이는 이름 · 값 · 오류(글 + 아이콘)', async () => {
    function R() {
      const [v, setV] = useState('');
      return <ApprovalReason label="사유(선택)" value={v} onChange={setV} error="너무 길어요" />;
    }
    await render(<R />);
    expect(container.querySelector('label')!.textContent).toBe('사유(선택)');
    const ta = container.querySelector('textarea')!;
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('너무 길어요');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, '범위 밖');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('textarea')!.value).toBe('범위 밖');
  });
});
