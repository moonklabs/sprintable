import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import {
  parseVerificationRail, VerifyRail, computeRailStageLabel, computeShowVerifyExamplePrompt,
  type DisplayStep,
} from './verify-rail';
import ko from '../../../messages/ko.json';

// story #2415(2026-08-02, 라이브 재확認 중 발견) — recruiter-client.tsx·connect-step.tsx가
// 각자 `json.data.steps`를 읽었는데, 백엔드(`GET /agents/{id}/verification-status`)의 실제
// 필드명은 `rail`이다. `steps`는 항상 undefined였으므로 검증이 실제로 성공해도 화면 레일은
// 초기 pending에서 한 번도 안 움직였다 — curl로 직접 확認한 실 응답 형태 그대로 고정한다.
describe('parseVerificationRail — story #2415 (steps→rail 필드명 회귀 고정)', () => {
  it('parses the real backend shape ({data:{rail:[...]}}) — this is the exact response captured live via curl', () => {
    const realResponse = {
      data: {
        agent_id: '381276fa-ba35-432a-b5a6-9feadc6c9b03',
        verification_seq: null,
        verified: true,
        rail: [
          { state: 'config_copied', status: 'done' },
          { state: 'waiting', status: 'done' },
          { state: 'mcp_reachable', status: 'done' },
          { state: 'verified', status: 'done' },
        ],
      },
      error: null,
      meta: null,
    };
    expect(parseVerificationRail(realResponse)).toEqual([
      { state: 'config_copied', status: 'done' },
      { state: 'waiting', status: 'done' },
      { state: 'mcp_reachable', status: 'done' },
      { state: 'verified', status: 'done' },
    ]);
  });

  it('regression: a `steps` field (the bug this replaces) is NOT read as rail data', () => {
    // 이전 버그의 정확한 재현 — `steps`라는 필드는 백엔드에 존재한 적이 없다. 이 필드가
    // 있어도(다른 소비처의 실수·구버전 mock 등) 그것을 rail로 오인해서는 안 된다.
    const responseWithWrongFieldName = {
      data: { verified: true, steps: [{ state: 'verified', status: 'done' }] },
    };
    expect(parseVerificationRail(responseWithWrongFieldName)).toBeNull();
  });

  it('returns null (not a crash, not stale data) on malformed/empty responses', () => {
    expect(parseVerificationRail(null)).toBeNull();
    expect(parseVerificationRail(undefined)).toBeNull();
    expect(parseVerificationRail({})).toBeNull();
    expect(parseVerificationRail({ data: {} })).toBeNull();
    expect(parseVerificationRail('not an object')).toBeNull();
  });

  it('also accepts a bare top-level rail (defensive — matches the pre-existing fallback shape)', () => {
    const bareShape = { rail: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(bareShape)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });

  it('also accepts data itself being the array (defensive — matches the pre-existing fallback shape)', () => {
    const dataIsArray = { data: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(dataIsArray)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });
});

function render(steps: DisplayStep[]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <VerifyRail steps={steps} />
    </NextIntlClientProvider>,
  );
}

function step(overrides: Partial<DisplayStep>): DisplayStep {
  return { state: 'mcp_reachable', status: 'done', label: '테스트 단계', ...overrides };
}

// story #2418 — BE는 지금 어떤 rail 단계에도 status:"failed"를 내지 않는다(backend/app/
// services/agent_verify.py::build_verification_rail/build_http_verification_rail 전수 확認 —
// 만드는 값은 pending/active/done뿐, reason 필드 자체가 없다). 즉 지금은 "reason이 가끔
// 빈다"가 아니라 "이 분기가 아직 한 번도 실행된 적 없는 죽은 경로"다 — 그래도 미래에 failed가
// 생기면 그 순간 이 자리가 처음 뜨므로, reason 없이 침묵하지 않도록 방어적으로 fallback을
// 세운다(모르는 것을 모른다고 말하는 편이 침묵보다 낫다).
describe('VerifyRail — story #2418 (failed인데 reason이 없으면 침묵하지 않는다)', () => {
  it('reason이 있으면 그 reason 그대로 보여준다', () => {
    const markup = render([step({ status: 'failed', reason: 'MCP 서버에 연결할 수 없습니다' })]);
    expect(markup).toContain('MCP 서버에 연결할 수 없습니다');
    expect(markup).not.toContain('왜인지 서버가 말해주지 않았습니다');
  });

  it('실측된 결함 재현 — failed인데 reason이 없으면(현재 BE 실제 형태) fallback 문구가 뜬다', () => {
    const markup = render([step({ status: 'failed', reason: undefined })]);
    expect(markup).toContain('왜인지 서버가 말해주지 않았습니다');
  });

  it('음성대조 — done/pending/active엔 fallback 문구가 뜨지 않는다', () => {
    for (const status of ['done', 'pending', 'active'] as const) {
      const markup = render([step({ status, reason: undefined })]);
      expect(markup).not.toContain('왜인지 서버가 말해주지 않았습니다');
    }
  });
});

// story #2419(유나 규격·PO 승인, design:changes 반영) — text-destructive는 bg-destructive/10
// 박스 위에서 3.97(AA 4.5 미달, apps/web/src/lib/color-contrast.test.ts에서 실측 고정).
// text-destructive-on-subtle로 교체해 약 4.98을 확保한다. dark: 짝은 안 붙인다 — .dark에도
// 이 변수가 --destructive로 alias돼 있어(globals.css) 이 클래스 하나만으로 dark에서도
// 안전하다(짝을 깜빡하면 var()가 미정의라 상속값으로 조용히 빠지는 문제를 이 alias가 막는다).
describe('VerifyRail — story #2419 (실패 사유 박스 텍스트 대비)', () => {
  it('실패 사유 박스는 text-destructive-on-subtle을 쓰고, 순수 text-destructive(대비 미달 조합)는 안 쓴다', () => {
    const markup = render([step({ status: 'failed', reason: '사유' })]);
    const classAttr = markup.match(/<div class="([^"]*)">사유<\/div>/)?.[1];
    expect(classAttr).toBeDefined();
    const classes = classAttr!.split(/\s+/);
    expect(classes).toContain('text-destructive-on-subtle');
    expect(classes).not.toContain('text-destructive');
  });
});

// story #2407 — recruiter-client.tsx·connect-step.tsx가 검증 레일 상태파생·폴링·핸들러를
// 각자 재구현하던 것을 useVerificationRail 하나로 모으면서, 근거 없이 갈려 있던 두 지점을
// connect-step의 (기술적으로 더 정확한) 쪽으로 통일했다 — recruiter 쪽 동작이 실제로 바뀌는
// 자리라 "판정이 아니라 실패하는 assert"로 고정한다(#2178 자).
describe('computeRailStageLabel — story #2407 ②-3 (transport 무관 항상 채워짐)', () => {
  const t = (key: 'railStageHosted' | 'railStageLocal') =>
    key === 'railStageHosted' ? '호스팅 · 4단계' : '로컬 · 6단계';

  it('http → 호스팅 라벨', () => {
    expect(computeRailStageLabel('http', t)).toBe('호스팅 · 4단계');
  });

  it('stdio → 로컬 라벨(예전 recruiter는 여기서 빈 문자열이었다 — 그 회귀를 막는 자리)', () => {
    expect(computeRailStageLabel('stdio', t)).toBe('로컬 · 6단계');
  });

  it('transport 미해소(null) → 로컬 라벨로 폴백(connect-step 기존 동작 그대로 보존)', () => {
    expect(computeRailStageLabel(null, t)).toBe('로컬 · 6단계');
  });
});

describe('computeShowVerifyExamplePrompt — story #2407 ②-4 (http에서만 인과적으로 정확)', () => {
  it('http·미검증 → 노출', () => {
    expect(computeShowVerifyExamplePrompt('http', false)).toBe(true);
  });

  it('http·검증완료 → 비노출', () => {
    expect(computeShowVerifyExamplePrompt('http', true)).toBe(false);
  });

  it('stdio·미검증 → 비노출(예전 recruiter는 여기서 노출했다 — heartbeat 없는 축이라 부정확한 안내였다)', () => {
    expect(computeShowVerifyExamplePrompt('stdio', false)).toBe(false);
  });

  it('transport 미해소(null) → 비노출', () => {
    expect(computeShowVerifyExamplePrompt(null, false)).toBe(false);
  });
});
