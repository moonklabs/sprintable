// @vitest-environment jsdom
//
// story #4246 — 필드 표 «형식» 칸은 사람 말만. 예전엔 유니언 배열(`["string","null"]`)을 그대로 돌려줘 React가 «stringnull»로
// 이어 그렸고(dev 배포 21 · 게이트 판정), enum은 내부어 «enum(…)», array · object · integer는 원문 그대로였다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventDefinitionSummary } from './event-definition-summary';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

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

// 게이트 판정(preset.gate.verdict) 필드 모양 + 시드에 실제로 있는 다른 타입(integer · number 유니언 · array · object).
const PAYLOAD_SCHEMA = {
  properties: {
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    reason_note: { type: ['string', 'null'] },
    decided_at: { type: ['string', 'null'], format: 'date-time' },
    attempt: { type: ['integer', 'null'] },
    cost: { type: ['number', 'null'] },
    tags: { type: 'array' },
    meta: { type: 'object' },
    free: {},
    weird: { type: 'uuid-ish' },
    tagsNullable: { type: ['array', 'null'] },
  },
  required: ['verdict'],
};

async function renderTypes(locale: 'ko' | 'en') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <EventDefinitionSummary payloadSchema={PAYLOAD_SCHEMA} routing={{}} actionAuth={null} blockTemplate={null} />
      </NextIntlClientProvider>,
    );
  });
  const cell = (name: string) => container.querySelector(`[data-testid="event-def-field-type-${name}"]`)?.textContent;
  return Object.fromEntries(Object.keys(PAYLOAD_SCHEMA.properties).map((name) => [name, cell(name)]));
}

describe('EventDefinitionSummary 필드 형식 칸(story #4246)', () => {
  it('ko — 유니언은 null을 뺀 타입의 사람 말 · enum은 선택지 · 원문 타입 이름 0', async () => {
    const o = koMessages.organization;
    const ko = await renderTypes('ko');
    expect(ko.verdict).toBe(`${o.definerFieldTypeEnum} approved, rejected`);
    // 값은 번역하지 않은 원문 · 값마다 <code>(유나 확정).
    expect([...container.querySelectorAll('[data-testid="event-def-field-type-verdict"] code')].map((c) => c.textContent)).toEqual(['approved', 'rejected']);
    expect(ko).toEqual({
      verdict: ko.verdict,
      reason_note: o.definerFieldTypeString,
      decided_at: o.definerFieldTypeDate,
      attempt: o.definerFieldTypeNumber,
      cost: o.definerFieldTypeNumber,
      tags: o.definerFieldTypeList,
      meta: o.definerFieldTypeObject,
      free: o.definerFieldTypeAny,
      weird: o.definerFieldTypeOther,
      tagsNullable: o.definerFieldTypeList,
    });
    const text = container.querySelector('table')?.textContent ?? '';
    for (const raw of ['stringnull', 'enum(', 'integer', 'array', 'object', 'null']) expect(text).not.toContain(raw);
  });

  it('en — 같은 규칙', async () => {
    const o = enMessages.organization;
    const types = await renderTypes('en');
    expect(types.reason_note).toBe(o.definerFieldTypeString);
    expect(types.verdict).toBe(`${o.definerFieldTypeEnum} approved, rejected`);
  });
});
