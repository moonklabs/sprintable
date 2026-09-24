// @vitest-environment jsdom
//
// story #4223(유나 비차단 둘) — ① en 개수 문구가 복수형 처리 없이 «1 gates»처럼 나왔다 → ICU plural(next-intl)로. 같은 모양의 en 개수
// 문구 전수를 바꿨고(57개), 새로 생기면 이 가드가 잡는다. ② 390 ko 조직 이벤트 필드 표 «필수»가 «필/수»로 세로 접혔다 → 낱말 줄바꿈 금지.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import {
  isArgumentElement, isLiteralElement, isNumberElement, isPluralElement, isSelectElement, isTagElement, parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';
import { EventDefinitionSummary } from '@/components/organization/event-definition-summary';

// story #4223(배포 20 라이브 미달 · PO 00:17Z) — 옛 가드는 자리표시자 이름(`{count}`·`{n}`…)만 봐서 `{stageCount} stages`처럼 다른 이름의 개수
// 자리를 놓쳤다(4587 파서와 같은 부류). 이제 **ICU 파서 AST**로 본다: plural/select 밖에서 «단순 인자(또는 `{x, number}`) 바로 뒤 복수형 낱말»이면
// 자리표시자 이름과 무관하게 잡는다. 동사·기능어(«{name} is»)는 제외. 숫자가 아닌 인자(이름·그룹)나 늘 2 이상인 값은 아래 목록에 **근거와 함께**만.
const ALLOWED_BARE_COUNT: Record<string, string> = {
  'docs.searchResultsCapped': 'count = DOC_SEARCH_LIMIT(50) 상수 — 1이 될 수 없음',
  'orgBriefing.clusterAuthFailureDiagnostic': '소비처 0(i18n-dead-key-baseline)',
  'orgBriefing.clusterSilentStallSub': '소비처 0(i18n-dead-key-baseline)',
  'standup.entryCount': '소비처 0(i18n-dead-key-baseline)',
  'cage.trustScoreWindowHint': '소비처 0(i18n-dead-key-baseline)',
  'agents.toolPermissions.expandTools': '{group}은 도구 묶음 이름(수가 아님) — «Git tools»',
  'content.channelPostsImageAnimatedUnsupported': '{frameCount}는 애니메이션 프레임 수(늘 2 이상) · 모르면 빈 문자열이라 plural 불가',
};

// ICU로 파싱되지 않는 ko·en 문구는 0이어야 한다 — use-intl은 값 없이 부르면 prod에서 원문을 그대로 내지만 dev(또는 값을 넘길 때)는 컴파일해
// 오류 폴백(키 경로)으로 떨어진다(값을 넘기는 순간 터지는 잠복 결함). 알려진 예외 목록 없음.

// «{x} is»처럼 인자 뒤가 동사·기능어면 개수 문구가 아니다.
const NOT_A_COUNT_NOUN = new Set(['is', 'was', 'has', 'as', 'needs', 'stays', 'does', 'goes', 'gets', 'says', 'its', 'this', 'plus', 'yes', 'us']);

function bareCountInElements(elements: MessageFormatElement[]): string[] {
  const out: string[] = [];
  elements.forEach((el, i) => {
    const next = elements[i + 1];
    if ((isArgumentElement(el) || isNumberElement(el)) && next && isLiteralElement(next)) {
      const m = /^\s+([A-Za-z]+s)\b/.exec(next.value);
      if (m && !NOT_A_COUNT_NOUN.has(m[1]!.toLowerCase())) out.push(`{${el.value}} ${m[1]}`);
    }
    if (isPluralElement(el) || isSelectElement(el)) {
      for (const opt of Object.values(el.options)) out.push(...bareCountInElements(opt.value));
    }
    if (isTagElement(el)) out.push(...bareCountInElements(el.children));
  });
  return out;
}

function scanMessages(): { bare: string[]; parseErrors: string[] } {
  const bare: string[] = [];
  const parseErrors: string[] = [];
  const walk = (locale: 'en' | 'ko', o: Record<string, unknown>, p: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = p ? `${p}.${k}` : k;
      if (v && typeof v === 'object') walk(locale, v as Record<string, unknown>, key);
      else if (typeof v === 'string') {
        let ast: MessageFormatElement[];
        try { ast = parse(v); } catch { parseErrors.push(`${locale}:${key}`); continue; }
        if (locale === 'en' && bareCountInElements(ast).length > 0) bare.push(key);
      }
    }
  };
  walk('en', enMessages as unknown as Record<string, unknown>, '');
  walk('ko', koMessages as unknown as Record<string, unknown>, '');
  return { bare: bare.filter((k) => !(k in ALLOWED_BARE_COUNT)).sort(), parseErrors: parseErrors.sort() };
}

describe('en 개수 문구 복수형(story #4223)', () => {
  it('⭐plural 밖의 «인자 + 복수형 낱말» en 문구 0 — 자리표시자 이름 무관(AST · 허용 목록은 근거 명시)', () => {
    expect(scanMessages().bare).toEqual([]);
  });

  it('⭐ICU로 파싱 안 되는 ko·en 문구 0(예외 목록 없음)', () => {
    expect(scanMessages().parseErrors).toEqual([]);
  });

  it('⭐셸 명령 예시의 키 자리(agentFakechatEnvKeyInstruction)는 대괄호 — 두 경로(값 없이·값 넘김) 모두 보이는 글자 그대로', () => {
    const en = createTranslator({ locale: 'en', messages: enMessages });
    const ko = createTranslator({ locale: 'ko', messages: koMessages });
    const enText = "① In the launch shell, export SPRINTABLE_API_KEY=[this agent's key].";
    const koText = '① 런치 셸에 export SPRINTABLE_API_KEY=[이 에이전트의 키]를 넣으세요.';
    expect(en('settings.agentFakechatEnvKeyInstruction')).toBe(enText);
    expect(en('settings.agentFakechatEnvKeyInstruction', { unused: '' })).toBe(enText);
    expect(ko('settings.agentFakechatEnvKeyInstruction')).toBe(koText);
    expect(ko('settings.agentFakechatEnvKeyInstruction', { unused: '' })).toBe(koText);
  });

  it('⭐JSON 예시 자리표시자(gcCredentialPlaceholder)는 ICU 이스케이프 뒤에도 보이는 글자 그대로(ko·en · 값 없이/있이)', () => {
    const en = createTranslator({ locale: 'en', messages: enMessages });
    const ko = createTranslator({ locale: 'ko', messages: koMessages });
    const json = '{ "type": "service_account", "project_id": "…", "private_key": "…" }';
    // 값 없이 = use-intl prod 원문 경로(이스케이프가 있으면 컴파일) · 값을 넘기면 = 컴파일 경로 — 두 경로 모두 보이는 글자가 같아야 한다.
    expect(en('organization.gcCredentialPlaceholder')).toBe(`Paste ${json}`);
    // story #4240 — 한국어 조사는 붙여 쓴다(«} 를» 0 · «}를» 1).
    expect(ko('organization.gcCredentialPlaceholder')).toBe(`${json}를 붙여넣어요`);
    expect(ko('organization.gcCredentialPlaceholder')).not.toContain('} 를');
    expect(en('organization.gcCredentialPlaceholder', { unused: '' })).toBe(`Paste ${json}`);
    expect(ko('organization.gcCredentialPlaceholder', { unused: '' })).toBe(`${json}를 붙여넣어요`);
  });

  it('양성·음성 대조 — 이름이 무엇이든 잡고, 동사·plural 안·숫자 아닌 자리는 안 잡는다', () => {
    const hits = (m: string) => bareCountInElements(parse(m));
    expect(hits('{stageCount} stages · {gateCount} gates')).toEqual(['{stageCount} stages', '{gateCount} gates']);
    expect(hits('Up to {limit, number} members')).toEqual(['{limit} members']);
    expect(hits('{name} is typing')).toEqual([]);
    expect(hits('{n, plural, one {# stage} other {# stages}}')).toEqual([]);
    expect(hits('Hello {name}, welcome')).toEqual([]);
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

  it('⭐배포 20 라이브 미달 — 레시피 상세 요약 «1 gate» · 오늘 머리 요약 · 인원 한도 · 경과 일수(1·N)', () => {
    const t = createTranslator({ locale: 'en', messages: enMessages });
    expect(t('organization.recipeDetailSummary', { stageCount: 7, gateCount: 1, roleCount: 3 })).toBe('7 stages · 1 gate · 3 roles');
    expect(t('organization.recipeDetailSummary', { stageCount: 1, gateCount: 2, roleCount: 1 })).toBe('1 stage · 2 gates · 1 role');
    expect(t('todayV3.headerSummary', { decisions: 1, agents: 1 })).toBe('1 decision needs your call · 1 agent is working on your tasks.');
    expect(t('todayV3.headerSummary', { decisions: 3, agents: 2 })).toBe('3 decisions need your call · 2 agents are working on your tasks.');
    expect(t('settings.memberLimitExceededError', { limit: 1 })).toBe('The free plan allows up to 1 member');
    expect(t('dashboard.ccAttentionDays', { days: 1 })).toBe('1 day');
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
