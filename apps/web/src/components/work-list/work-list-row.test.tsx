// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    title: '할일 제목', ownerName: null, isDelegated: false, lowRisk: false, hasArtifacts: false, state: null,
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

  it('사람 손 필요 3어(승인·서명·답 대기)는 warning(amber) 배지 — 「오늘」과 같은 사실 같은 색(story #3853 정렬, PO 지적)', async () => {
    for (const state of ['awaiting_approval', 'awaiting_signature', 'awaiting_answer'] as const) {
      await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state })} />)); });
      expect(container.querySelector('.bg-warning-tint')).not.toBeNull();
      expect(container.querySelector('.bg-info-tint')).toBeNull();
    }
    for (const state of ['in_progress', 'done'] as const) {
      await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ state })} />)); });
      expect(container.querySelector('.bg-warning-tint')).toBeNull();
    }
  });

  it('lowRisk=true일 때만 저위험 칩', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ lowRisk: true })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipLowRisk);

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ lowRisk: false })} />)); });
    expect(container.textContent).not.toContain(koMessages.workList.chipLowRisk);
  });

  it('hasArtifacts=true일 때만 산출물 칩', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ hasArtifacts: true })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipHasArtifacts);
  });

  it('isDelegated=true일 때만 위임 칩(ownerName 있으면 이름도 함께)', async () => {
    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: true, ownerName: '미르코' })} />)); });
    expect(container.textContent).toContain(koMessages.workList.chipDelegated);
    expect(container.textContent).toContain('미르코');

    await act(async () => { root.render(wrap(<WorkListRowView row={baseRow({ isDelegated: false })} />)); });
    expect(container.textContent).not.toContain(koMessages.workList.chipDelegated);
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
});
