// story #4008(E-UX-OVERHAUL·v3 셸 실시간) AC7 — v3 화면 파일에 EventSource/연결
// 생성 코드가 직접 있으면 안 된다(전부 useChatSse 경유만 허용 — 화면마다 따로 SSE를
// 붙이면 연결이 화면 수만큼 늘고 복붙이 생긴다는 스토리 본문의 우려를 grep으로 고정).
//
// PO CHANGES 2(2026-09-17) — 이 가드는 「화면 파일에 EventSource 문자열이 없다」만
// 잰다. 그건 필요조건이지 충분조건이 아니다: 실사고로 발견된 진짜 문제(탭당 연결이
// prod 설정에서 2개로 늚)는 파일 하나에 `EventSource` 리터럴이 있어서가 아니라
// `useChatSse`를 두 컴포넌트가 각자 불러서 생긴 **구조** 문제라 이 grep이 원천적으로
// 못 본다 — 그 구조 문제의 주 증거는
// `chat-v3-screen.eventsource-count.test.tsx`(실 EventSource 생성 개수를 런타임에서
// 직접 잰다)가 맡는다. 이 파일은 여전히 유효한 보조 가드(향후 누군가 실수로 화면
// 파일에 EventSource를 직접 박으면 여기서도 잡힌다)로 유지하되, 「양성 대조」를
// 무관 파일(hooks/use-chat-sse.ts) 존재 확인에서 — 이 가드의 판정 함수 자체가 합성
// 위반 소스를 실제로 RED로 뒤집는지 확인하는 걸로 바꾼다(검출 로직 자체를 검증).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_V3_DIR = path.resolve(SCRIPT_DIR, '../src/components/chat-v3');

export function realCodeLines(src: string): string[] {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'));
}

export function hasRawEventSource(src: string): boolean {
  return realCodeLines(src).some((line) => line.includes('EventSource'));
}

describe('verify-chat-v3-no-raw-eventsource(story #4008 AC7)', () => {
  it('chat-v3-*.tsx 화면 파일 전부에 EventSource 직접 생성 코드가 0건이다', () => {
    const files = fs.readdirSync(CHAT_V3_DIR).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(CHAT_V3_DIR, file), 'utf-8');
      if (hasRawEventSource(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  // PO CHANGES 2 — 「양성 대조」란 이 가드의 검출 로직이 실제로 위반을 잡아내는지를
  // 확인하는 것이지, 무관한 파일(hooks/use-chat-sse.ts)에 그 문자열이 있다는 사실이
  // 아니다(그건 대조가 아니라 별개 사실 확인). 합성 소스로 직접 RED를 뒤집어 본다.
  it('⭐양성 대조 — 합성 위반 소스(EventSource 직접 생성 흉내)는 실제로 RED로 잡힌다', () => {
    const violatingSource = `
      export function BadScreen() {
        const source = new EventSource('/api/event-stream');
        return source;
      }
    `;
    expect(hasRawEventSource(violatingSource)).toBe(true);
  });

  it('음성 대조 — 주석 안의 EventSource 언급은 위반으로 안 잡는다(실 코드만 스캔)', () => {
    const commentOnlySource = `
      // EventSource는 여기서 안 쓴다 — useChatSse 경유
      export function GoodScreen() { return null; }
    `;
    expect(hasRawEventSource(commentOnlySource)).toBe(false);
  });

  it('use-chat-sse.ts 훅 자체는 EventSource를 직접 연다(이 가드의 스캔 대상 밖 — hooks/ 디렉터리)', () => {
    const hookSrc = fs.readFileSync(path.resolve(SCRIPT_DIR, '../src/hooks/use-chat-sse.ts'), 'utf-8');
    expect(hasRawEventSource(hookSrc)).toBe(true);
  });
});
