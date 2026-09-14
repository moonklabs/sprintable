// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { WorkListRowView } from './work-list-row';
import type { WorkListRow } from './derive-work-list';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function baseRow(overrides: Partial<WorkListRow> = {}): WorkListRow {
  return {
    id: 't1', kind: 'task', workItemType: 'task', workItemId: 't1',
    title: '할일 제목', ownerName: null, isDelegated: false, lowRisk: false, artifactCount: 0, state: null,
    ...overrides,
  };
}

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

describe('WorkListRowView', () => {
  it('제목은 항상 그린다', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow()} />)); });
    expect(container.textContent).toContain('할일 제목');
  });

  it('state=null이면 상태 배지를 안 그린다(폴백도 없이 진행 중/완료 어느 쪽도 아님을 있는 그대로)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow()} />)); });
    expect(container.textContent).not.toContain(koMessages.workList.stateInProgress);
    expect(container.textContent).not.toContain(koMessages.workList.stateDone);
  });

  it('§① 4상태 낱말을 정확히 그린다', async () => {
    for (const [state, label] of [
      ['awaiting_approval', koMessages.workList.stateAwaitingApproval],
      ['awaiting_signature', koMessages.workList.stateAwaitingSignature],
      ['awaiting_answer', koMessages.workList.stateAwaitingAnswer],
      ['in_progress', koMessages.workList.stateInProgress],
      ['done', koMessages.workList.stateDone],
    ] as const) {
      await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state })} />)); });
      expect(container.textContent).toContain(label);
    }
  });

  it('사람 손 필요 3어(승인·서명·답 대기)는 색 글자 text-warning-strong — pill/Badge 아님(시안 06d2d61c 재대조, PO 지적)', async () => {
    for (const state of ['awaiting_approval', 'awaiting_signature', 'awaiting_answer'] as const) {
      await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state })} />)); });
      expect(container.querySelector('.text-warning-strong')).not.toBeNull();
      // 색 글자로 바뀌었으니 배지 tint 배경(bg-warning-tint 등)은 이 상태 자리에 없어야 한다.
      expect(container.querySelector('.bg-warning-tint, .bg-info-tint')).toBeNull();
    }
  });

  it('진행 중=muted 글자·완료=success 글자(색 pill 아님)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state: 'in_progress' })} />)); });
    expect(container.querySelector('.text-muted-foreground')).not.toBeNull();

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state: 'done' })} />)); });
    const doneText = [...container.querySelectorAll('.text-success')].find((el) => el.textContent === koMessages.workList.stateDone);
    expect(doneText).not.toBeUndefined();
  });

  it('lowRisk=true일 때만 저위험 칩', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ lowRisk: true })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipLowRisk);

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ lowRisk: false })} />)); });
    expect(container.textContent).not.toContain(koMessages.workList.chipLowRisk);
  });

  it('artifactCount>0일 때만 산출물 칩(실 개수 표시, PO 지적 — 있음/없음 아님)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ artifactCount: 3 })} />)); });
    expect(container.textContent).toContain('산출물 3');

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ artifactCount: 0 })} />)); });
    expect(container.textContent).not.toContain('산출물');
  });

  it('isDelegated=true면 위임 칩(이름은 칩이 아니라 행 부제로 — PO 지적)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: true, ownerName: '미르코' })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipDelegated);
    expect(container.textContent).toContain('미르코');
    expect(container.textContent).not.toContain(koMessages.workList.chipAssigned);
  });

  it('isDelegated=false·ownerName 있으면 배정 칩(사람 배정 행, PO 지적 — 신설)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: false, ownerName: '사람' })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipAssigned);
    expect(container.textContent).toContain('사람');
    expect(container.textContent).not.toContain(koMessages.workList.chipDelegated);
  });

  it('ownerName=null이면 배정/위임 칩 둘 다 없다(지어내지 않는다)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: false, ownerName: null })} />)); });
    expect(container.textContent).not.toContain(koMessages.workList.chipDelegated);
    expect(container.textContent).not.toContain(koMessages.workList.chipAssigned);
  });

  it('행 부제=ownerName(있을 때만)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ ownerName: '디디' })} />)); });
    expect(container.textContent).toContain('디디');

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ ownerName: null })} />)); });
    expect(container.textContent).not.toContain('디디');
  });

  it('위임+진행 중/완료 행만 채운 점 표식을 그린다(승인 대기 등은 표식 없음)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: true, state: 'in_progress' })} />)); });
    expect(container.querySelector('[aria-hidden="true"].bg-primary')).not.toBeNull();

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: true, state: 'done' })} />)); });
    expect(container.querySelector('[aria-hidden="true"].bg-success')).not.toBeNull();

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: true, state: 'awaiting_approval' })} />)); });
    expect(container.querySelector('.bg-primary, .bg-success')).toBeNull();
  });

  it('⭐라이브 렌더 실사고 재발방지 — 미위임(isDelegated=false) 행은 진행 중/완료여도 점을 안 찍는다', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: false, state: 'in_progress' })} />)); });
    expect(container.querySelector('.bg-primary, .bg-success')).toBeNull();

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: false, state: 'done' })} />)); });
    expect(container.querySelector('.bg-primary, .bg-success')).toBeNull();
  });

  // story #3845(우패널) — onSelect 없이는 기존 소비처(위 모든 테스트)가 그대로 무변(클릭
  // 불가·role 없음) — onSelect가 있을 때만 새 행동이 켜진다(양성대조).
  it('onSelect 없이 렌더하면 클릭 핸들러·role이 없다(기존 소비처 회귀 0)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow()} />)); });
    const rowEl = container.firstElementChild as HTMLElement;
    expect(rowEl.getAttribute('role')).toBeNull();
  });

  it('⭐onSelect가 있으면 클릭 시 row.id로 불린다', async () => {
    const onSelect = vi.fn();
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ id: 'row-42' })} onSelect={onSelect} />)); });
    const rowEl = container.firstElementChild as HTMLElement;
    expect(rowEl.getAttribute('role')).toBe('button');
    await act(async () => { rowEl.click(); });
    expect(onSelect).toHaveBeenCalledWith('row-42');
  });

  it('isSelected=true면 선택 하이라이트(bg-muted 토큰 — hover:bg-muted와는 다른 자리)가 붙는다', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow()} onSelect={() => {}} isSelected />)); });
    const rowEl = container.firstElementChild as HTMLElement;
    expect(rowEl.classList.contains('bg-muted')).toBe(true);

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow()} onSelect={() => {}} isSelected={false} />)); });
    const rowEl2 = container.firstElementChild as HTMLElement;
    expect(rowEl2.classList.contains('bg-muted')).toBe(false);
  });
});
