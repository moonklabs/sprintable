// @vitest-environment jsdom
//
// story #3743(UI 재설계 ③) — 옛 connectors/page.tsx의 카드형 CRUD 편집 UI(org_config
// input·저장)는 시안에 없다(사람의 자기서비스 편집 경로가 아니라 담당 에이전트가
// 설정하는 것 — 페드루 PO 確定). 이 파일은 새 계약만 pin: 준비 여부 파생·행 렌더·
// 담당에게 요청 링크.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentSetupSection, missingRequiredConnectorFieldNames, type ConnectorItem } from './agent-setup-section';

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

function connector(overrides: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    connector_key: 'stibee', version: '1.0.0', channel: 'stibee', kinds: ['publish'],
    requires_env: ['STIBEE_ACCESS_TOKEN'],
    fields: [
      { name: 'create.senderEmail', source: 'org_config', required: true },
      { name: 'create.listId', source: 'org_config', required: true },
    ],
    org_config: {},
    ...overrides,
  };
}

describe('missingRequiredConnectorFieldNames', () => {
  it('필수 org_config 필드 중 빈 것만 뽑는다', () => {
    expect(missingRequiredConnectorFieldNames(connector())).toEqual(['create.senderEmail', 'create.listId']);
    expect(missingRequiredConnectorFieldNames(connector({ org_config: { 'create.senderEmail': 'a@b.com', 'create.listId': 1 } }))).toEqual([]);
  });
});

describe('AgentSetupSection', () => {
  it('⭐준비된 커넥터는 「준비됨」+요청 버튼 없음, 미완료는 「설정 필요」+담당에게 요청 링크', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/organizations/org-1/connectors') {
        return {
          ok: true,
          json: async () => ({
            data: [
              connector({ connector_key: 'threads', channel: 'threads', org_config: {}, fields: [] }),
              connector({ connector_key: 'stibee', channel: 'stibee' }),
            ],
          }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await act(async () => { root.render(wrap(<AgentSetupSection orgId="org-1" />)); });
    await flush();

    const threadsRow = container.querySelector('[data-testid="agent-setup-row-threads"]');
    expect(threadsRow?.querySelector('[data-status-chip="ready"]')).toBeTruthy();
    expect(threadsRow?.querySelector('a')).toBeNull();

    const stibeeRow = container.querySelector('[data-testid="agent-setup-row-stibee"]');
    expect(stibeeRow?.querySelector('[data-status-chip="needs_setup"]')).toBeTruthy();
    const link = stibeeRow?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/chats');
    expect(stibeeRow?.textContent).toContain('create.senderEmail');
  });

  it('커넥터 0건이면 구획 자체를 안 그린다(없는 자리를 그리지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(wrap(<AgentSetupSection orgId="org-1" />)); });
    await flush();
    expect(container.textContent).toBe('');
  });

  it('로딩 실패도 구획 자체를 안 그린다(페이지 레벨 에러 배너와 안 겹친다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<AgentSetupSection orgId="org-1" />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});
