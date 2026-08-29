// story #3196 ① — release-notes-gate의 신규계정 캐치업 억제 판정을 순수함수로 pin한다
// (mount 없이 — chat-view.tsx의 mergeBackfilledMessages 등과 동형 관례).
import { describe, expect, it } from 'vitest';
import { decideReleaseNotesGate } from './release-notes-gate';

describe('decideReleaseNotesGate', () => {
  it('brand-new 계정(첫 로드, seen===null)은 모달을 안 열고 조용히 latest를 seen으로 기록만 한다', () => {
    const d = decideReleaseNotesGate(null, 'note-3');
    expect(d.shouldOpen).toBe(false);
    expect(d.writeSeenAs).toBe('note-3');
  });

  it('returning 유저가 최신 노트보다 뒤처져 있으면(seen이 오래됨) 정상 오픈 — 기존 동작 무회귀', () => {
    const d = decideReleaseNotesGate('note-1', 'note-3');
    expect(d.shouldOpen).toBe(true);
    expect(d.writeSeenAs).toBeNull();
  });

  it('이미 최신을 본 유저는 안 연다', () => {
    const d = decideReleaseNotesGate('note-3', 'note-3');
    expect(d.shouldOpen).toBe(false);
    expect(d.writeSeenAs).toBeNull();
  });

  it('노트가 아예 없으면(latest=null) 아무 것도 안 한다', () => {
    const d = decideReleaseNotesGate(null, null);
    expect(d.shouldOpen).toBe(false);
    expect(d.writeSeenAs).toBeNull();
    const d2 = decideReleaseNotesGate('note-1', null);
    expect(d2.shouldOpen).toBe(false);
    expect(d2.writeSeenAs).toBeNull();
  });

  it('brand-new 캐치업 억제 後 실제로 새 노트가 또 나오면(다음 실행에서 seen=이전 latest, 새 latest 도착) 정상 오픈', () => {
    // 1회차: 첫 로드 — 억제.
    const first = decideReleaseNotesGate(null, 'note-3');
    expect(first.shouldOpen).toBe(false);
    // 2회차: 그 seen 값을 그대로 들고 새 릴리스가 나온 상황 — 이제는 진짜 새 소식이라 열림.
    const second = decideReleaseNotesGate(first.writeSeenAs, 'note-4');
    expect(second.shouldOpen).toBe(true);
  });
});
