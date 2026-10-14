// story 4677 (UX-1 · P4) AC2 — one thing for «an agent being in a project» (유나 §L ④): «프로젝트 팀에 들어가 있어요» (ko) / «On … team» (en).
// The old words «접근 허용 / 접근 차단» and «프로젝트에 추가해 주세요» are gone from the messages — a copy that comes back turns this RED.
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const koText = JSON.stringify(ko);
const enText = JSON.stringify(en);

describe('[SID:4677] AC2 — the old access words stay out of the messages', () => {
  it('ko: no «접근 허용» · «접근 차단» · «프로젝트에 추가해 주세요»', () => {
    for (const old of ['접근 허용', '접근 차단', '프로젝트에 추가해 주세요']) expect(koText, old).not.toContain(old);
  });

  it('en: the agent card line is not the old «# project(s) granted» counter · «Allow access» / «Block access» appear nowhere', () => {
    const line = (en as unknown as { connectRulesV3: { agentAccessGranted: string } }).connectRulesV3.agentAccessGranted;
    expect(line).not.toContain('granted');
    for (const old of ['Allow access', 'Block access']) expect(enText, old).not.toContain(old);
  });
});

describe('[SID:4677] AC2 — the agent card line (connect rules › agents · admin): connectRulesV3.agentAccessGranted', () => {
  type Translate = (key: string, values?: Record<string, number | string>) => string;
  const t = (locale: 'ko' | 'en'): Translate =>
    createTranslator({ locale, messages: (locale === 'ko' ? ko : en) as unknown as Record<string, never>, namespace: 'connectRulesV3' }) as unknown as Translate;

  it('ko: none → «아직 어느 프로젝트 팀에도 없어요» · n → «프로젝트 팀 n곳에 들어가 있어요»', () => {
    const k = t('ko');
    expect(k('agentAccessGranted', { count: 0 })).toBe('아직 어느 프로젝트 팀에도 없어요');
    expect(k('agentAccessGranted', { count: 1 })).toBe('프로젝트 팀 1곳에 들어가 있어요');
    expect(k('agentAccessGranted', { count: 3 })).toBe('프로젝트 팀 3곳에 들어가 있어요');
  });

  it("en: none → «Not on any project's team yet» · 1 → «On 1 project's team» · n → «On n projects' teams»", () => {
    const e = t('en');
    expect(e('agentAccessGranted', { count: 0 })).toBe("Not on any project's team yet");
    expect(e('agentAccessGranted', { count: 1 })).toBe("On 1 project's team");
    expect(e('agentAccessGranted', { count: 2 })).toBe("On 2 projects' teams");
  });
});
