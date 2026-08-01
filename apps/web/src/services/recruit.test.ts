// story #2377 §2(규격 A) — 「깨우기」 축. 유나양 규격(doc `runtime-connect-guidance-spec-2377`
// v1.2) §0: MCP 연결만으로는 「어떤 런타임도」 안 깨어난다(실측 5/5) — 그 사실을 화면이 말하려면
// 런타임별 실제 깨우기 경로가 어딘가 데이터로 있어야 한다. onboarding-guide.txt의 Runtime
// catalog 표(:152-165)를 FE에 미러한 이 표가 그 자리다.
import { describe, expect, it } from 'vitest';
import { RUNTIME_WAKE_MECHANISM, resolveRuntimeWakeInfo } from './recruit';

describe('resolveRuntimeWakeInfo — story #2377 §2', () => {
  it('maps each of the 9 named runtimes + the generic connector slug to their real wake mechanism(onboarding-guide.txt Runtime catalog 표와 대조)', () => {
    expect(resolveRuntimeWakeInfo('claude-code')).toEqual({ method: 'channel-plugin', path: 'packages/fakechat' });
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
