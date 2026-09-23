// @vitest-environment jsdom
//
// story #4223(유나 비차단 둘) — ① en 개수 문구가 복수형 처리 없이 «1 gates»처럼 나왔다 → ICU plural(next-intl)로. 같은 모양의 en 개수
// 문구 전수를 바꿨고(57개), 새로 생기면 이 가드가 잡는다. ② 390 ko 조직 이벤트 필드 표 «필수»가 «필/수»로 세로 접혔다 → 낱말 줄바꿈 금지.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import { EventDefinitionSummary } from '@/components/organization/event-definition-summary';

// 그대로 둔 것(근거): 상수 50 이상이라 1이 될 수 없음 · 소비처 0(dead-key baseline 등재) — 바꿀 이유가 없는 자리.
const ALLOWED_BARE_COUNT: Record<string, string> = {
  'docs.searchResultsCapped': 'count = DOC_SEARCH_LIMIT(50) 상수 — 1이 될 수 없음',
  'orgBriefing.clusterAuthFailureDiagnostic': '소비처 0(i18n-dead-key-baseline)',
  'standup.entryCount': '소비처 0(i18n-dead-key-baseline)',
};

function bareCountMessages(): string[] {
  const hits: string[] = [];
  const walk = (o: Record<string, unknown>, p: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === 'object') walk(v as Record<string, unknown>, key);
      else if (typeof v === 'string') {
        // plural 블록 밖에서 `{수} 영어복수명사`(…s)가 나오면 복수형 미처리.
        const outside = v.replace(/\{\w+, plural,(?:[^{}]|\{[^{}]*\})*\}/g, '');
        if (/\{(count|n|total|num|number)\}\s+[a-z]+s\b/.test(outside)) hits.push(key);
      }
    }
  };
  walk(enMessages as unknown as Record<string, unknown>, '');
  return hits.filter((k) => !(k in ALLOWED_BARE_COUNT)).sort();
}

describe('en 개수 문구 복수형(story #4223)', () => {
  it('⭐plural 밖의 `{수} …s` en 문구 0(허용 목록 셋 · 근거 명시)', () => {
    expect(bareCountMessages()).toEqual([]);
  });

  it('«1 gate» · «2 gates» · «1 of 1 goal has …» · «1 link wasn’t saved»', () => {
    const t = createTranslator({ locale: 'en', messages: enMessages });
    expect(t('organization.recipeGalleryGateCountBadge', { count: 1 })).toBe('1 gate');
    expect(t('organization.recipeGalleryGateCountBadge', { count: 2 })).toBe('2 gates');
    expect(t('flow.nextMakerHeadline', { needsNext: 1, total: 1 })).toBe('1 of 1 goal has no "next" set');
    expect(t('chats.referenceDropNoticeCount', { count: 1 })).toBe("1 link wasn't saved");
    // 까디르 QA — 복합 주어(«Alice and 1 other»)는 두 분기 모두 are · «{owned} of them»은 owned로 is/are.
    expect(t('chats.othersTyping', { name: 'Alice', count: 1 })).toBe('Alice and 1 other are typing');
    expect(t('chats.othersTyping', { name: 'Alice', count: 2 })).toBe('Alice and 2 others are typing');
    // 유나 확정 문안(0·1·N) — 한 개면 «of them» 대신 «it».
    expect(t('flow.nextMakerBacklogLine', { n: 1, owned: 1 })).toBe("1 item not ready yet — it's owned");
    expect(t('flow.nextMakerBacklogLine', { n: 1, owned: 0 })).toBe('1 item not ready yet — no one owns it yet');
    expect(t('flow.nextMakerBacklogLine', { n: 3, owned: 0 })).toBe('3 items not ready yet — none of them are owned yet');
    expect(t('flow.nextMakerBacklogLine', { n: 3, owned: 1 })).toBe('3 items not ready yet — 1 of them is owned');
    expect(t('flow.nextMakerBacklogLine', { n: 3, owned: 2 })).toBe('3 items not ready yet — 2 of them are owned');
    expect(t('settings.agentScopeAllProjectsHint', { count: 1 })).toBe('Granted to the only project.');
    expect(t('settings.agentScopeAllProjectsHint', { count: 4 })).toBe('Granted to all 4 projects.');
  });

  it('수신자 수는 숫자로 넘기고 자리 구분은 ICU가 로케일로(en·ko 둘 다 1,234)', () => {
    const en = createTranslator({ locale: 'en', messages: enMessages });
    const ko = createTranslator({ locale: 'ko', messages: koMessages });
    expect(en('cage.newsletterEstimatedRecipientCount', { count: 1234 })).toBe('1,234 recipients');
    expect(en('cage.newsletterEstimatedRecipientCount', { count: 1 })).toBe('1 recipient');
    expect(ko('cage.newsletterEstimatedRecipientCount', { count: 1234 })).toContain('1,234');
  });
});

describe('조직 이벤트 필드 표 «필수» 한 줄(story #4223)', () => {
  it('⭐필수/선택 칸은 낱말 줄바꿈 금지(whitespace-nowrap)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EventDefinitionSummary
            payloadSchema={{ properties: { title: { type: 'string' } }, required: ['title'] }}
            routing={{}} actionAuth={null} blockTemplate={null}
          />
        </NextIntlClientProvider>,
      );
    });
    const cell = container.querySelector('[data-testid="event-def-field-required-title"]');
    expect(cell?.textContent).toBe(koMessages.organization.definerFieldRequired);
    expect(cell?.className.split(/\s+/)).toContain('whitespace-nowrap');
    await act(async () => { root.unmount(); });
    container.remove();
  });
});
