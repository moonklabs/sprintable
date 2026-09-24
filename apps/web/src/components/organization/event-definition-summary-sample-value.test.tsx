// @vitest-environment jsdom
//
// story #4257 — 조직 레시피 «실물 미리보기»의 예시값이 en에서도 한국어 «예시 resolution_note»였다(예시값 생성 두 곳이 «예시 ${name}» 고정).
// 이제 로케일 문구(organization.definerSampleValue)로 — en «Sample …» · ko «예시 …».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventDefinitionSummary } from './event-definition-summary';
import enMessages from '../../../messages/en.json';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const TEMPLATE = { blocks: [{ type: 'fields', fields: [
  { label: 'note', value: '{{payload.resolution_note}}' }, { label: 'sum', value: '{{payload.summary}}' },
] }] };
const SCHEMA = { properties: { resolution_note: { type: 'string' }, summary: { type: 'string' } } };

async function renderPreview(locale: 'en' | 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : koMessages} timeZone="Asia/Seoul">
        <EventDefinitionSummary payloadSchema={SCHEMA} routing={{}} actionAuth={null} blockTemplate={TEMPLATE} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const details = container.querySelector('details');
  return (container.textContent ?? '').replace(details?.textContent ?? '', '');
}

describe('EventDefinitionSummary 미리보기 — 예시값은 로케일 문구(story #4257)', () => {
  it('⭐en → «Sample resolution_note» · 한국어 «예시» 0', async () => {
    const text = await renderPreview('en');
    expect(text).toContain('Sample resolution_note');
    expect(text).toContain('Sample summary');
    expect(text).not.toContain('예시');
  });

  it('ko → 이름만 아는 필드는 «예시 resolution_note» · 뜻을 아는 summary는 «예시 요약»(«예시 summary» 아님)', async () => {
    const text = await renderPreview('ko');
    expect(text).toContain('예시 resolution_note');
    expect(text).toContain('예시 요약');
    expect(text).not.toContain('예시 summary');
  });
});
