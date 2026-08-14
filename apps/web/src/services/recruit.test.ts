// story #2377 §2(규격 A) — 「깨우기」 축. 유나양 규격(doc `runtime-connect-guidance-spec-2377`
// v1.2) §0: MCP 연결만으로는 「어떤 런타임도」 안 깨어난다(실측 5/5) — 그 사실을 화면이 말하려면
// 런타임별 실제 깨우기 경로가 어딘가 데이터로 있어야 한다. onboarding-guide.txt의 Runtime
// catalog 표(:152-165)를 FE에 미러한 이 표가 그 자리다.
import { describe, expect, it } from 'vitest';
import { RUNTIME_WAKE_MECHANISM, resolveRuntimeWakeInfo, type RuntimeWakeMethod, RUNTIME_CONNECT_CLI, resolveConnectConfirm } from './recruit';
import enMessages from '../../messages/en.json';
import koMessages from '../../messages/ko.json';

describe('resolveRuntimeWakeInfo — story #2377 §2', () => {
  it('maps each of the 9 named runtimes + the generic connector slug to their real wake mechanism(onboarding-guide.txt Runtime catalog 표와 대조)', () => {
    expect(resolveRuntimeWakeInfo('claude-code')).toEqual({
      method: 'channel-plugin-marketplace',
      path: 'claude plugin marketplace add moonklabs/sprintable-agent-plugins && claude plugin install sprintable@moonklabs',
    });
    expect(resolveRuntimeWakeInfo('codex')).toEqual({ method: 'connector-host', path: 'connectors/codex-sprintable/' });
    expect(resolveRuntimeWakeInfo('gemini')).toEqual({ method: 'connector-host', path: 'connectors/gemini-sprintable/' });
    expect(resolveRuntimeWakeInfo('grok')).toEqual({ method: 'connector-host', path: 'connectors/grok-sprintable/' });
    expect(resolveRuntimeWakeInfo('pi')).toEqual({ method: 'connector-host', path: 'connectors/pi-sprintable/' });
    expect(resolveRuntimeWakeInfo('hermes')).toEqual({ method: 'channel-plugin', path: 'connectors/hermes-sprintable/' });
    expect(resolveRuntimeWakeInfo('openclaw')).toEqual({ method: 'channel-plugin', path: 'connectors/openclaw-sprintable/' });
    expect(resolveRuntimeWakeInfo('opencode')).toEqual({ method: 'channel-plugin', path: 'connectors/opencode-sprintable/' });
    expect(resolveRuntimeWakeInfo('cursor')).toEqual({ method: 'connector-sidecar', path: 'connectors/cursor-sprintable/' });
    expect(resolveRuntimeWakeInfo('connector')).toEqual({ method: 'connector-sdk', path: 'connectors/sdk/' });
  });

  // ⛔story #2377 §2 처방 그대로 — 「없으면 없다고 말한다」. 지금 매핑에 없는(아직 등재 안 된) 새
  // 런타임 slug이 들어오면 조용히 사라지거나 잘못된 값을 내는 대신 명시적 `unknown`으로 떨어져야
  // 화면이 "아직 깨우는 방법이 없습니다"를 말할 수 있다 — 침묵은 이 스토리가 고치려는 그 병이다.
  it('falls back to "unknown" (never silent, never a wrong guess) for a runtime not yet in the table', () => {
    expect(resolveRuntimeWakeInfo('some-future-runtime')).toEqual({ method: 'unknown', path: '' });
  });

  it('the map has exactly the 10 slugs from RUNTIME_CAPABILITIES_FALLBACK — a new runtime added there without a matching entry here would silently fall back to "unknown" in the UI', () => {
    expect(Object.keys(RUNTIME_WAKE_MECHANISM).sort()).toEqual([
      'claude-code', 'codex', 'connector', 'cursor', 'gemini',
      'grok', 'hermes', 'openclaw', 'opencode', 'pi',
    ]);
  });
});

// ⛔유나양 지적(2026-08-01, PR#2768 design:pass 후속) — 슬러그 축(위 테스트)과 같은 갭이 method
// 축에도 있다. `recruiter-client.tsx`가 `t(\`kitOrientingWakeBody_${method}\`)`로 i18n 키를
// «동적 조합»하는데, `RuntimeWakeMethod` 유니온에 새 method를 추가하고 그 키를 en/ko에 안 넣으면
// TS가 못 잡고(템플릿 리터럴 조합 키의 존재는 타입 레벨에서 안 재진다) 화면에 raw 키
// ("kitOrientingWakeBody_그method")가 그대로 뜬다 — 조용한 실패. 지금은 완전하다(유니온 5종 중
// unknown은 별도 분기라 나머지 4종이 en/ko 둘 다에 있음) — 다만 이 동적 조합 자체를 이 PR이
// 도입했으므로, 다음 사람이 method를 추가하고 이 줄을 안 늘리면 그 자리에서 빨개지게 지금 막는다
// (슬러그 축에서 이미 쓴 처방과 같은 성질 — «사람이 기억해야» 하는 자리를 «상태가 스스로 서는»
// 자리로 바꾼다).
describe('kitOrientingWakeBody_<method> i18n coverage — story #2377 (유나양 design:pass 후속)', () => {
  // ⛔유나양 재지적(2026-08-01) — 위 배열 리터럴은 「원소가 유니온에 속하는가」만 보고 «완전성»은
  // 안 요구한다. `RuntimeWakeMethod`에 method가 하나 늘어도 이 배열을 안 늘리면 그냥 통과했다 —
  // 「method를 추가하고 이 줄을 안 늘리면 그 자리에서 빨개진다」던 위 주석이 «거짓»이었다(오늘
  // 온종일 잡은 그 병 — 서술이 실제와 어긋남 — 의 재발). `Record<..., true>`는 유니온의 «모든»
  // 키를 요구하므로, method가 늘고 이 객체를 안 늘리면 tsc가 즉시 빨개진다 — 주석이 약속한 것을
  // 타입이 실제로 하게 만든다.
  const NON_UNKNOWN_WAKE_METHOD_CHECK: Record<Exclude<RuntimeWakeMethod, 'unknown'>, true> = {
    'channel-plugin': true,
    'channel-plugin-marketplace': true,
    'connector-host': true,
    'connector-sidecar': true,
    'connector-sdk': true,
  };
  const NON_UNKNOWN_WAKE_METHODS = Object.keys(NON_UNKNOWN_WAKE_METHOD_CHECK) as Exclude<RuntimeWakeMethod, 'unknown'>[];

  it('every non-unknown RuntimeWakeMethod has a kitOrientingWakeBody_<method> key in both en.json and ko.json', () => {
    const en = (enMessages as { recruiter: Record<string, string> }).recruiter;
    const ko = (koMessages as { recruiter: Record<string, string> }).recruiter;
    for (const method of NON_UNKNOWN_WAKE_METHODS) {
      const key = `kitOrientingWakeBody_${method}`;
      expect(en[key], `en.json missing ${key}`).toBeTypeOf('string');
      expect(ko[key], `ko.json missing ${key}`).toBeTypeOf('string');
    }
  });
});

// story #2377 v1.3 §1.5/⑤(2026-08-05, PO 確定) — ①(도구 전달) 축의 런타임별 정확한 CLI 명령.
// hermes/openclaw는 파일이 아니라 자기 CLI로 등록하므로, generic ".mcp.json 파일" 프레이밍을
// 쓰면 §0급 "화면이 틀린 것을 단정"이 재발한다.
describe('RUNTIME_CONNECT_CLI — story #2377 v1.3 §1.5/⑤', () => {
  it('hermes/openclaw는 정확한 CLI 명령을 갖는다(호스트 CLI 실측 그대로)', () => {
    expect(RUNTIME_CONNECT_CLI.hermes).toBe('hermes mcp add --url --auth');
    expect(RUNTIME_CONNECT_CLI.openclaw).toBe("openclaw mcp set '<json>'");
  });

  it('파일기반 MCP-native 런타임(claude-code 등)은 이 표에 없다 — 기존 file-framing이 정확하므로 대체하지 않는다', () => {
    expect(RUNTIME_CONNECT_CLI['claude-code']).toBeUndefined();
    expect(RUNTIME_CONNECT_CLI.cursor).toBeUndefined();
  });
});

// story #2377 v1.3 §1.5/④(2026-08-05, PO+유나 홀름 정정) — ①이 "실제로 도착했다"는 확인 등급은
// «우리 팀이 실제로 실측한» 날짜 있는 사실만 'confirmed'다. 호스트 자기신고나 config-저장
// 성공만으로는 절대 'confirmed'가 아니다 — A-3 거짓성공의 화면판을 막는 게 이 표의 목적이다.
describe('resolveConnectConfirm — story #2377 v1.3 §1.5/④', () => {
  // PO+유나 정정(2026-08-05, #2856 design:changes) — codex ①은 matrix 정본상 [설정검증]뿐(도구
  // 목록 미확인, #2382 인용) — confirmed로 두면 "거짓성공 방지 배지" 스스로가 거짓성공을 켜는
  // 자리다. claude-code는 [라이브] 자기증명(이 세션 자체가 .mcp.json http 실사용 중)으로 추가.
  it('claude-code/hermes만 confirmed(팀이 실제로 실측한 날짜 있음)', () => {
    expect(resolveConnectConfirm('claude-code')).toEqual({ tier: 'confirmed', measuredAt: '2026-08-05' });
    expect(resolveConnectConfirm('hermes')).toEqual({ tier: 'confirmed', measuredAt: '2026-08-05' });
  });

  it('codex/openclaw는 config-verified — host가 config를 유효로 저장한 것만 확인됐을 뿐 실도착(도구 목록)은 미확인이라 confirmed가 아니다', () => {
    expect(resolveConnectConfirm('codex')).toEqual({ tier: 'config-verified' });
    expect(resolveConnectConfirm('openclaw')).toEqual({ tier: 'config-verified' });
  });

  it('나머지(측정 안 된) 런타임은 전부 unmeasured로 떨어진다 — 침묵도 성급한 confirmed도 아니다', () => {
    expect(resolveConnectConfirm('gemini')).toEqual({ tier: 'unmeasured' });
    expect(resolveConnectConfirm('grok')).toEqual({ tier: 'unmeasured' });
    expect(resolveConnectConfirm('pi')).toEqual({ tier: 'unmeasured' });
    expect(resolveConnectConfirm('cursor')).toEqual({ tier: 'unmeasured' });
    expect(resolveConnectConfirm('some-future-runtime')).toEqual({ tier: 'unmeasured' });
  });
});
