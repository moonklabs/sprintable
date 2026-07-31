import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countDynamicKeyCalls,
  findSubstringCollisions,
  flattenMessages,
  isNumberAdjacent,
  parseKeyUsages,
  parseTranslationBindings,
} from './verify-no-i18n-phrase-collision';

describe('parseTranslationBindings — story #2367', () => {
  it('const t = useTranslations(\'ns\') 바인딩을 뽑는다', () => {
    const src = `
      const t = useTranslations('flow');
      const tGlance = useTranslations('glance');
    `;
    const bindings = parseTranslationBindings(src);
    expect(bindings.get('t')).toBe('flow');
    expect(bindings.get('tGlance')).toBe('glance');
  });

  it('네임스페이스 없는 useTranslations()는 건너뛴다(안전한 쪽 누락)', () => {
    const bindings = parseTranslationBindings(`const t = useTranslations();`);
    expect(bindings.size).toBe(0);
  });
});

describe('parseKeyUsages', () => {
  it('바인딩된 변수로 부르는 t(\'key\') 호출을 (ns.key)로 뽑는다', () => {
    const bindings = new Map([['t', 'flow']]);
    const src = `t('nextMakerCanDo'); t("nextMakerUnowned", { n: 1 });`;
    const used = parseKeyUsages(src, bindings);
    expect(used).toEqual(new Set(['flow.nextMakerCanDo', 'flow.nextMakerUnowned']));
  });

  it('점 표기 nested key(예: claim.title)도 뽑는다', () => {
    const bindings = new Map([['t', 'proofCapsule']]);
    const used = parseKeyUsages(`t('claim.title')`, bindings);
    expect(used).toEqual(new Set(['proofCapsule.claim.title']));
  });

  it('바인딩 안 된 변수의 호출은 무시한다', () => {
    const bindings = new Map([['t', 'flow']]);
    const used = parseKeyUsages(`other('someKey')`, bindings);
    expect(used.size).toBe(0);
  });
});

describe('countDynamicKeyCalls — AC4㉡', () => {
  it('템플릿 리터럴로 조립되는 동적 키 호출을 센다(정적으로 못 뽑는 자리)', () => {
    const bindings = new Map([['t', 'flow']]);
    const src = 't(`status_${status}`); t(`status_${other}`); t(\'staticKey\');';
    expect(countDynamicKeyCalls(src, bindings)).toBe(2);
  });
});

describe('flattenMessages', () => {
  it('중첩 네임스페이스(예: proofCapsule.claim.title)를 점 표기로 평평화한다', () => {
    const flat = flattenMessages({
      flow: { title: '흐름' },
      proofCapsule: { claim: { title: '주장' } },
    });
    expect(flat.get('flow.title')).toBe('흐름');
    expect(flat.get('proofCapsule.claim.title')).toBe('주장');
  });
});

describe('isNumberAdjacent', () => {
  it('{n}류 보간 자리가 있으면 true', () => {
    expect(isNumberAdjacent('목표 · {n}')).toBe(true);
    expect(isNumberAdjacent('{count}개 문서 일치')).toBe(true);
  });

  it('보간 자리가 없으면 false', () => {
    expect(isNumberAdjacent('막힘')).toBe(false);
    expect(isNumberAdjacent('저장 완료')).toBe(false);
  });
});

describe('findSubstringCollisions — AC3 (겹치는 짝 + 안 겹치는 짝 둘 다)', () => {
  it('한쪽이 수와 함께 서고 부분문자열로 겹치면 잡는다(양성)', () => {
    const phrases = new Map([
      ['a.blocked', { value: '막힘', numberAdjacent: false }],
      ['b.blockedCount', { value: '게이트·막힘 신호 · {n}', numberAdjacent: true }],
    ]);
    const collisions = findSubstringCollisions(phrases);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ keyA: 'a.blocked', keyB: 'b.blockedCount' });
  });

  it('겹치지만 «둘 다» 수와 무관하면 안 잡는다(음성 — docs.save/statusSaved 모양)', () => {
    const phrases = new Map([
      ['docs.save', { value: '저장', numberAdjacent: false }],
      ['docs.statusSaved', { value: '저장 완료', numberAdjacent: false }],
    ]);
    expect(findSubstringCollisions(phrases)).toHaveLength(0);
  });

  it('부분문자열 관계가 아예 없으면 안 잡는다(음성 — 무관한 두 라벨)', () => {
    const phrases = new Map([
      ['a.total', { value: '전체 · {n}', numberAdjacent: true }],
      ['b.owner', { value: '담당자', numberAdjacent: false }],
    ]);
    expect(findSubstringCollisions(phrases)).toHaveLength(0);
  });

  it('완전히 동일한 값을 가리키는 두 다른 키도 잡는다(가장 강한 충돌 형태)', () => {
    const phrases = new Map([
      ['dashboard.a', { value: '{gate} 대기 중', numberAdjacent: true }],
      ['dashboard.b', { value: '{gate} 대기 중', numberAdjacent: true }],
    ]);
    expect(findSubstringCollisions(phrases)).toHaveLength(1);
  });
});

// ── AC2 — #2352·#2365 옛 값을 되돌려 넣어 빨개지는 것을 보인다 ────────────────
//
// ⛔두 실사고 자체는 서로 다른 파일(next-maker-header.tsx ↔ flow-client.tsx)이 원인이라
// v1(같은 파일 스코프)이 원 사고를 그대로 재현하진 못한다(모듈 코멘트 AC4㉠). 그래도 그
// «모양»(짧은 라벨이 카운터 달린 긴 문구의 부분문자열) 자체는 한 파일 안에서 합성 픽스처로
// 재현해 파이프라인(바인딩→호출 추적→충돌 판정)이 실제로 빨개지는 것을 보인다.
describe('AC2 — 옛 값(#2352·#2365 모양) 되돌리면 파이프라인이 빨개진다(합성 픽스처)', () => {
  it('#2352 모양 — "막힘"과 "게이트·막힘 신호 · {n}"이 한 파일에 같이 있으면 잡힌다', () => {
    const bindings = parseTranslationBindings(`const t = useTranslations('flow');`);
    const src = `
      const t = useTranslations('flow');
      <Cell label={t('blockedLabel')} />
      <Drawer text={t('blockedCount', { n: count })} />
    `;
    const usages = parseKeyUsages(src, bindings);
    const messages = new Map([
      ['flow.blockedLabel', '막힘'],
      ['flow.blockedCount', '게이트·막힘 신호 · {n}'],
    ]);
    const phrases = new Map(
      [...usages]
        .filter((k) => messages.has(k))
        .map((k) => [k, { value: messages.get(k)!, numberAdjacent: isNumberAdjacent(messages.get(k)!) }] as const),
    );
    expect(findSubstringCollisions(phrases)).toHaveLength(1);
  });

  it('#2365 모양 — "승인 대기"와 "게이트 승인 대기 · {n}"이 한 파일에 같이 있으면 잡힌다', () => {
    const bindings = parseTranslationBindings(`const t = useTranslations('flow');`);
    const src = `
      const t = useTranslations('flow');
      <Drawer text={t('gatePendingKind')} />
      <Cell label={t('pendingApprovalHeadline', { n: count })} />
    `;
    const usages = parseKeyUsages(src, bindings);
    const messages = new Map([
      ['flow.gatePendingKind', '승인 대기'],
      ['flow.pendingApprovalHeadline', '게이트 승인 대기 · {n}'],
    ]);
    const phrases = new Map(
      [...usages]
        .filter((k) => messages.has(k))
        .map((k) => [k, { value: messages.get(k)!, numberAdjacent: isNumberAdjacent(messages.get(k)!) }] as const),
    );
    expect(findSubstringCollisions(phrases)).toHaveLength(1);
  });
});

// AC7 — 첫 검거를 «지어낸 것»이 아니라 «실제 저장소에 있는 것»으로도 보인다(오르테가군
// 지적, 2026-07-31) — action-zone.tsx의 ccWaitingGateReason과 ccAgentStuck이 완전히 같은
// 템플릿("{gate} 대기 중")을 같은 파일에서 쓴다. 오늘 이 스토리가 실제로 처음 잡은 것 중
// 하나 — 고치지 않고(AC6) 그대로 재현만 고정한다.
describe('AC7 — 실제 저장소의 첫 검거 재현(action-zone.tsx)', () => {
  it('ccWaitingGateReason과 ccAgentStuck이 완전히 같은 템플릿이라 잡힌다', () => {
    const file = path.resolve(__dirname, '../src/components/dashboard/command-center/action-zone.tsx');
    const content = readFileSync(file, 'utf8');
    const bindings = parseTranslationBindings(content);
    expect(bindings.get('t')).toBe('dashboard');
    const usages = parseKeyUsages(content, bindings);
    expect(usages.has('dashboard.ccWaitingGateReason')).toBe(true);
    expect(usages.has('dashboard.ccAgentStuck')).toBe(true);

    const messagesPath = path.resolve(__dirname, '../messages/ko.json');
    const messages = flattenMessages(JSON.parse(readFileSync(messagesPath, 'utf8')));
    const phrases = new Map(
      [...usages]
        .filter((k) => messages.has(k))
        .map((k) => [k, { value: messages.get(k)!, numberAdjacent: isNumberAdjacent(messages.get(k)!) }] as const),
    );
    const collisions = findSubstringCollisions(phrases);
    const hit = collisions.find(
      (c) =>
        new Set([c.keyA, c.keyB]).has('dashboard.ccWaitingGateReason') &&
        new Set([c.keyA, c.keyB]).has('dashboard.ccAgentStuck'),
    );
    expect(hit).toBeDefined();
  });
});
