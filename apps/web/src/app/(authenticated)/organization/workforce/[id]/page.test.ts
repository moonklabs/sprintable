// story #2739 후속(2026-07-31, PO 실측) — fakechat 온보딩 안내가 실제 코드가 읽는 env 키
// 이름과 달랐다. packages/fakechat/server.ts:27가 SPRINTABLE_API_KEY를 먼저 보고
// AGENT_API_KEY는 하위호환 폴백일 뿐인데, 화면 안내는 AGENT_API_KEY만 말하고 있었다.
// i18n 값 자체를 직접 확認하는 값 회귀가드 — 컴포넌트 렌더 없이 문자열만 잰다.
import { describe, expect, it } from 'vitest';
import ko from '../../../../../../messages/ko.json';
import en from '../../../../../../messages/en.json';

describe('workforce agent detail — fakechat env key onboarding copy (story #2739 후속)', () => {
  it('ko/en 안내 문구 둘 다 SPRINTABLE_API_KEY를 말하고, 옛 AGENT_API_KEY는 0건이다', () => {
    expect(ko.settings.agentFakechatEnvKeyInstruction).toContain('SPRINTABLE_API_KEY');
    expect(ko.settings.agentFakechatEnvKeyInstruction).not.toContain('AGENT_API_KEY');
    expect(en.settings.agentFakechatEnvKeyInstruction).toContain('SPRINTABLE_API_KEY');
    expect(en.settings.agentFakechatEnvKeyInstruction).not.toContain('AGENT_API_KEY');
  });
});
