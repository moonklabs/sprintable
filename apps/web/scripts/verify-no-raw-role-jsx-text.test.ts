import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJsxFileContent, scanRepo } from './verify-no-raw-role-jsx-text';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('scanJsxFileContent — story #3770 셀프테스트', () => {
  it('⭐bare identifier {role} → RED', () => {
    const src = `function C() { return <span>{role}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐property access {profile.role} → RED', () => {
    const src = `function C() { return <span>{profile.role}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐중첩 property access {agent.role} → RED', () => {
    const src = `function C() { return <Badge variant="outline">{agent.role}</Badge>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  // 뮤테이션 대조 — 정본 헬퍼로 감싸면(t()/orgRoleLabel()/resolveRoleLabel() 동형) 이
  // 스캔이 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — orgRoleLabel(profile.role, t)로 감싼 형은 GREEN(CallExpression이라 대상 밖)', () => {
    const src = `function C() { return <span>{orgRoleLabel(profile.role, t)}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('뮤테이션 대조 — resolveRoleLabel(agent.role, null, t)로 감싼 형은 GREEN', () => {
    const src = `function C() { return <Badge>{resolveRoleLabel(agent.role, null, t)}</Badge>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — <select value={member.role}>는 JSX 속성(JsxAttribute)이지 자식(JsxChild)이
  // 아니다. roles/page.tsx:168 실사용 형과 동형(정당).
  it('음성대조 — <option value={member.role}>는 GREEN(속성 자리는 애초 대상 밖)', () => {
    const src = `function C() { return <select value={member.role}><option value={member.role}>x</option></select>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 조건부 렌더의 가드 조건 자체(top-level이 ConditionalExpression)는 대상 밖.
  // chat-input.tsx의 `{member.role ? <span>...</span> : null}` 감싸는 형과 동형.
  it('음성대조 — 삼항 가드 조건({member.role ? <x/> : null})의 조건 자체는 안 걸린다(안쪽만 검사)', () => {
    const src = `function C() { return <>{member.role ? <span>{label}</span> : null}</>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('음성대조 — role로 끝나지 않는 프로퍼티({member.roleLabel})는 GREEN', () => {
    const src = `function C() { return <span>{member.roleLabel}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanJsxFileContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('scanJsxFileContent — story #3875(status/activity_type 축 신설)', () => {
  it('⭐bare identifier {status} → RED(field=status)', () => {
    const src = `function C() { return <span>{status}</span>; }`;
    const refs = scanJsxFileContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.field).toBe('status');
  });

  it('⭐property access {activity.activity_type} → RED(field=activity_type)', () => {
    const src = `function C() { return <span>{activity.activity_type}</span>; }`;
    const refs = scanJsxFileContent(src, 'fake.tsx');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.field).toBe('activity_type');
  });

  it('뮤테이션 대조 — t(statusKey)로 감싼 형은 GREEN(CallExpression이라 대상 밖)', () => {
    const src = `function C() { return <span>{t(statusKey)}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 무관 PR no-op 표본(PO AC3) — 이 축과 무관한 평범한 컴포넌트는 위반 0으로 조용히
  // 통과한다는 것 자체를 표본 1로 고정(다른 PR의 CI를 이 축이 헛돌려 막지 않는다는 확인).
  it('무관 표본 — role/status/activity_type을 전혀 안 쓰는 평범한 컴포넌트는 GREEN(exit 0)', () => {
    const src = `function C({ title, count }: { title: string; count: number }) {
      return <div><h1>{title}</h1><span>{count}</span></div>;
    }`;
    expect(scanJsxFileContent(src, 'unrelated.tsx')).toEqual([]);
  });

  // 실 파일 뮤테이션(합성 표본 아님, PO AC3 명시) — story-detail-panel.tsx의
  // formatActivityMessage default 케이스를 되돌려(t('activityOtherChangeLabel') → 원시
  // activity_type) RED가 되는지 직접 확인한다.
  describe('실 파일 뮤테이션 — story-detail-panel.tsx(default 케이스)', () => {
    const REL_FILE = 'components/kanban/story-detail-panel.tsx';
    const ABS_FILE = path.join(SRC_ROOT, REL_FILE);
    const original = readFileSync(ABS_FILE, 'utf8');

    it('전제: 원본은 이 파일에서 위반 0(activity_type이 t(\'activityOtherChangeLabel\')로 감싸짐)', () => {
      const refs = scanJsxFileContent(original, REL_FILE);
      expect(refs.filter((r) => r.field === 'activity_type')).toEqual([]);
    });

    it('default 케이스를 원시 activity_type으로 되돌리면 RED', () => {
      const target = "return <span className=\"text-foreground\">{t('activityOtherChangeLabel')}</span>;\n    }\n  };";
      expect(original.includes(target)).toBe(true);
      const mutated = original.replace(
        target,
        "return <span className=\"text-foreground\">{activity_type}</span>;\n    }\n  };",
      );
      expect(mutated).not.toBe(original);

      const refs = scanJsxFileContent(mutated, REL_FILE);
      const activityTypeRefs = refs.filter((r) => r.field === 'activity_type');
      expect(activityTypeRefs.length).toBeGreaterThan(0);
    });
  });
});

describe('scanRepo — story #3770(실 트리 실행)', () => {
  // story #3773 — event stage role 2곳이 stageRoleLabel() 정본으로 닫혀 role 축 ALLOWLIST가
  // 비었다(죽은 ALLOWLIST 자가검출 — 유나 확認대로 이 가드가 스스로 RED로 잡았고, 그 항목을
  // 걷었다). story #3875 — status/activity_type 축 신설로 실측 17건이 새 ALLOWLIST에
  // 등재됐다(구조적 오탐 2·§⑤ 미감사 화면 2·실 위반이나 스코프 밖 13 — 근거는 ALLOWLIST
  // 주석 참고, story-detail-panel.tsx의 activity_type 자리는 이 카드에서 t() 경유로 고쳐
  // ALLOWLIST에 없다).
  it('실 트리(apps/web/src) — 위반 0건, ALLOWLIST 17건(story #3875 신규 축)', () => {
    const { refs, fileCount, allowlistHit } = scanRepo(SRC_ROOT);
    expect(fileCount).toBeGreaterThan(400);
    expect(refs).toEqual([]);
    expect(allowlistHit.size).toBe(17);
  });
});
