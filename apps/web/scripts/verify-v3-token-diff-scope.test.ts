/**
 * story #3826(UX-v3·FE 2) AC1 diff 가드 핫픽스(2026-09-14, PR#4256/#4257 CI 차단·
 * 페드루 PO 確定) — `classifyDiffScope`(changedFiles·globals.css --proof-* 값줄 변경
 * 개수 → verdict) 순수 함수 pin. 원 결함: 이 가드가 모든 PR에서 무조건 돌면서
 * globals.css 외 파일이 있으면 "이 PR이 토큰 PR인가"를 안 묻고 FAIL했다 — 4표본으로
 * 그 판정을 고정한다((a)는 옛 로직으로 되돌리면 RED).
 */
import { describe, expect, it } from 'vitest';
import { classifyDiffScope, countProofTokenLineChanges, isPromotionBaseRef } from './verify-v3-token-diff-scope';

const TARGET_FILE = 'apps/web/src/app/globals.css';

describe('classifyDiffScope — 핫픽스 스코프 판정', () => {
  it('(a) globals.css 없이 다른 파일만 changedFiles에 있으면 OK(no-op) — 옛 로직으로 되돌리면 RED', () => {
    const verdict = classifyDiffScope(['apps/web/src/components/foo.tsx', 'apps/web/package.json'], 0);
    expect(verdict.kind).toBe('not_applicable');
  });

  it('(b) globals.css는 있으나 --proof-* 값줄 변경 0(비토큰 변경)이면 OK', () => {
    const verdict = classifyDiffScope([TARGET_FILE], 0);
    expect(verdict.kind).toBe('out_of_scope');
  });

  it('(c) globals.css --proof-* 값줄 변경 + tsx 동반이면 FAIL(스코프 밖 파일)', () => {
    const verdict = classifyDiffScope([TARGET_FILE, 'apps/web/src/components/foo.tsx'], 1);
    expect(verdict.kind).toBe('fail');
  });

  it('(d) globals.css --proof-* 값줄 변경 단독이면 in_scope(기존 3축으로 진행)', () => {
    const verdict = classifyDiffScope([TARGET_FILE], 3);
    expect(verdict.kind).toBe('in_scope');
  });

  it('allowlist 파일 동반은 (d)와 동형 — 3826 스캐폴딩 자신은 계속 통과', () => {
    const verdict = classifyDiffScope(
      [TARGET_FILE, 'apps/web/scripts/verify-v3-token-diff-scope.ts'],
      2,
    );
    expect(verdict.kind).toBe('in_scope');
  });
});

describe('classifyDiffScope — story #4011 AC2 base 축 표 테스트', () => {
  it('ⓐ base=main(승격 PR) + --proof-* 값줄 변경 + 다른 파일 다수 → OK(skip) — 이 스킵 조건을 지우면 RED(원 결함 재현)', () => {
    const verdict = classifyDiffScope(
      [TARGET_FILE, 'apps/web/src/components/foo.tsx', 'backend/app/main.py'],
      5,
      true,
    );
    expect(verdict.kind).toBe('not_applicable');
  });

  it('ⓑ base=develop + 같은 변경 → FAIL(기존 AC1 음성 대조 유지, 바이트 무변)', () => {
    const verdict = classifyDiffScope(
      [TARGET_FILE, 'apps/web/src/components/foo.tsx', 'backend/app/main.py'],
      5,
      false,
    );
    expect(verdict.kind).toBe('fail');
  });

  it('ⓒ base=스택 부모 브랜치(main도 develop도 아님) + 같은 변경 → FAIL(isPromotionBase=false와 동형)', () => {
    expect(isPromotionBaseRef('origin/feat/3997-members-runtime-type')).toBe(false);
    const verdict = classifyDiffScope(
      [TARGET_FILE, 'apps/web/src/components/foo.tsx'],
      3,
      isPromotionBaseRef('origin/feat/3997-members-runtime-type'),
    );
    expect(verdict.kind).toBe('fail');
  });

  it('ⓓ base=develop + globals.css만 --proof-* 값줄 변경 → OK(기존 in_scope 판정 무변)', () => {
    const verdict = classifyDiffScope([TARGET_FILE], 3, false);
    expect(verdict.kind).toBe('in_scope');
  });
});

describe('isPromotionBaseRef', () => {
  it('origin/main·bare main은 승격 base로 판정', () => {
    expect(isPromotionBaseRef('origin/main')).toBe(true);
    expect(isPromotionBaseRef('main')).toBe(true);
  });

  it('origin/develop·스택 브랜치·main을 이름에 포함만 하는 브랜치는 승격 base가 아니다', () => {
    expect(isPromotionBaseRef('origin/develop')).toBe(false);
    expect(isPromotionBaseRef('origin/feat/4011-v3-token-diff-guard-promote-scope')).toBe(false);
    // "main"으로 끝나지 않는 한 다른 위치에 포함돼도 오탐 금지(예: 브랜치명에 "main"이 부분 문자열).
    expect(isPromotionBaseRef('origin/maintenance-branch')).toBe(false);
  });
});

describe('countProofTokenLineChanges', () => {
  it('--proof-* 값줄만 세고 다른 선언·구조 문자는 0으로 친다', () => {
    const lines = [
      '  --proof-ink: #111111;',
      '  --color-proof-ink: var(--proof-ink);',
      '{',
      '}',
      '  --proof-radius-soft: 0.5rem;',
    ];
    expect(countProofTokenLineChanges(lines)).toBe(2);
  });

  it('빈 배열(변경 없음)은 0', () => {
    expect(countProofTokenLineChanges([])).toBe(0);
  });
});
