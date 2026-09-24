// @vitest-environment jsdom
//
// story #2889(S2h①③)·S2d(미르코) — gate는 reference_registry TARGET_ONLY라
// RICH_PREVIEW_TYPES/ENTITY_API/getEntityHref(parity 대상)엔 못 들어간다. EntityPreviewModal
// 안에 독립 gate 분기(fetch·href·renderGateSummary)를 추가했다 — 여기는 그 분기의 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EntityPreviewModal } from './embed-card';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetchWithAuth(impl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => impl(url)));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('EntityPreviewModal gate 분기 — story #2889/S2d', () => {
  it('/api/gates/{id}를 fetch해 title·gate_type·risk 배지를 렌더한다', async () => {
    stubFetchWithAuth(async (url) => {
      expect(url).toBe('/api/gates/g-1');
      return {
        ok: true,
        // /api/gates/[id]는 proxyToFastapi — BE GateResponse 날 JSON(#4253 · 예전 {data} 목이 미리보기 본문 빈 채를 가렸다).
        json: async () => ({
          id: 'g-1', status: 'pending', gate_type: 'merge', risk_grade: 'high',
          work_item_summary: { title: 'PR#42 병합 게이트', slug: null }, work_item_id: 'wi-1',
        }),
      };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EntityPreviewModal entityType="gate" entityId="g-1" title={null} status={null} href={null} onClose={() => {}} embedded />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain('PR#42 병합 게이트');
    // story #4253(유나 CHANGES · PO 13:46Z) — 종류 · 상태는 공용 낱말(gateTypeLabel · gateStatusLabel). 원시 키(merge · pending)는 안 찍는다.
    expect(container.textContent).toContain(koMessages.dashboard.ccGateTypeMerge);
    expect(container.textContent).toContain(koMessages.cage.gateStatusPending);
    expect(container.textContent).not.toContain('merge');
    expect(container.textContent).not.toContain('pending');
    expect(container.textContent).toContain('고위험');
  });

  it('en — 종류 · 상태 배지가 영어 낱말(원시 키 doc_approval · approved 0)', async () => {
    stubFetchWithAuth(async () => ({
      ok: true,
      json: async () => ({ id: 'g-9', status: 'approved', gate_type: 'doc_approval', risk_grade: 'low', work_item_summary: { title: 'Spec', slug: null }, work_item_id: 'wi-9' }),
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
          <EntityPreviewModal entityType="gate" entityId="g-9" title={null} status={null} href={null} onClose={() => {}} embedded />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain(enMessages.dashboard.ccGateTypeDocApproval);
    expect(container.textContent).toContain(enMessages.cage.gateStatusApproved);
    expect(container.textContent).not.toContain('doc_approval');
  });

  // story #3888(§⑤·Chat) — risk_grade='unknown' 배지(workList.riskBadgeUnknown, 신규 키)
  // 회귀가드. "High risk"와 마찬가지로 이전엔 "Risk unknown" 리터럴이었다.
  it('risk_grade=unknown이면 "위험도 모름" 배지를 렌더한다', async () => {
    stubFetchWithAuth(async () => ({
      ok: true,
      json: async () => ({
        id: 'g-3', status: 'pending', gate_type: 'merge', risk_grade: 'unknown',
        work_item_summary: { title: '위험도 미산정 게이트', slug: null }, work_item_id: 'wi-3',
      }),
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EntityPreviewModal entityType="gate" entityId="g-3" title={null} status={null} href={null} onClose={() => {}} embedded />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain('위험도 모름');
    expect(container.textContent).not.toContain('고위험');
  });

  it('전체 보기 링크가 /gates/{id}로 향한다(own-href, parity getEntityHref 무관)', async () => {
    stubFetchWithAuth(async () => ({
      ok: true,
      json: async () => ({ id: 'g-2', status: 'pending', gate_type: 'doc_approval', risk_grade: 'low' }),
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EntityPreviewModal entityType="gate" entityId="g-2" title={null} status={null} href={null} onClose={() => {}} embedded />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    const link = container.querySelector('a[href="/gates/g-2"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('전체 보기');
  });

  it('fetch 실패 시 "대상을 찾을 수 없어요"로 정직하게 떨어진다(무한 스피너 금지)', async () => {
    stubFetchWithAuth(async () => ({ ok: false, json: async () => ({}) }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EntityPreviewModal entityType="gate" entityId="g-3" title={null} status={null} href={null} onClose={() => {}} embedded />
        </NextIntlClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain('대상을 찾을 수 없어요');
  });
});
