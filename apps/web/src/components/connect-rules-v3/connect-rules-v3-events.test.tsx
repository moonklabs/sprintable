// @vitest-environment jsdom
//
// story #3985 — 「이벤트·자동화」 진입·요약 절. 3상태(로딩·빈·오류)와 사라짐 0(정의가
// 0건이어도 「이벤트 관리」 링크는 항상 렌더). AC1 그라운딩 확인 — "켜진 워크플로
// 프리셋 이름"은 출처가 없어 이 절엔 그 줄 자체가 없다(지어내기 0, 이 파일이 그 부재를
// 음성대조로 고정).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();

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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { ConnectRulesV3Events } = await import('./connect-rules-v3-events');
  await act(async () => { root.render(wrap(<ConnectRulesV3Events orgId="org1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('ConnectRulesV3Events', () => {
  it('⭐빈 상태 — 정의 0건이어도 「이벤트 관리」 링크는 사라지지 않는다', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    await mount();
    expect(container.textContent).toContain('아직 정의가 없어요');
    expect(container.textContent).toContain('이벤트 관리');
  });

  it('오류 — 「다시 시도」 버튼이 보인다', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
    expect(container.querySelector('button')?.textContent).toContain('다시 시도');
  });

  it('⭐내가 만든 정의·기본 제공 정의 — org_id 유무로 정확히 가른다(events/page.tsx와 같은 술어)', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { org_id: 'org1' }, { org_id: 'org1' }, { org_id: null }, { org_id: null }, { org_id: null },
        ],
      }),
    });
    await mount();
    expect(container.textContent).toContain('내가 만든 정의');
    expect(container.textContent).toContain('기본 제공 정의');
    // CountBadge가 숫자를 그대로 텍스트로 낸다 — 2(custom)·3(preset).
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('3');
  });

  it('원시 배열 응답(래핑 없이)도 받는다 — events/page.tsx와 같은 두 형태 허용', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ([{ org_id: null }]) });
    await mount();
    expect(container.textContent).toContain('기본 제공 정의');
  });

  it('⭐"켜진 워크플로 프리셋" 줄은 그리지 않는다(AC1 그라운딩 — 출처 없음)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ org_id: 'org1' }] }) });
    await mount();
    expect(container.textContent).not.toContain('프리셋');
    expect(container.textContent).not.toContain('워크플로');
  });
});
