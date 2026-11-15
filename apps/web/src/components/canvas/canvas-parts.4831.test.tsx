// @vitest-environment jsdom
//
// story 4831 부품 교체(공용 부품 ③) — 캔버스의 글 칸 여덟 곳(코멘트 쓰기 · 핀 설명 · 답글 · 커밋 요약 · 속성 글자 · 버전 고르기 · 내보내기 링크 · HTML 붙여넣기)이
// 바탕 Input · Select · Textarea가 되어도 쓴 값이 제출·호출 값으로 같은 모양으로 이어지고, 폭 · 크기 클래스(w-auto · min-w-0 · flex-1 · resize-none · min-h-0)가 그대로인지 결과로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentComposePopover } from './comment-compose-popover';
import { PinAuthoringPopover } from './pin-authoring-popover';
import { CommentThreadCard } from './comment-thread-card';
import { CommitBar } from './commit-bar';
import { PropertyPanel } from './property-panel';
import { ArtifactViewer } from './artifact-viewer';
import { ExportDialog } from './export-dialog';
import { ImportArtifactDialog } from './import-artifact-dialog';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';
import type { ArtifactNode } from '@/services/canvas-nodes';

vi.mock('@/services/canvas-export', () => ({
  canPngExport: () => false,
  applyCaptureConditions: () => () => {},
  exportPng: async () => null,
  createHtmlExport: async () => ({ download_url: 'https://files.example/export-1.html' }),
}));
vi.mock('@/lib/clipboard', () => ({ copyTextSafely: async () => ({ ok: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const c = koMessages.canvas as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const mount = async (node: React.ReactNode) => { await act(async () => { root.render(wrap(node)); }); };
const frame = async () => { await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); }); };
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
// 부품이 이미 갖고 있는 «file:text-foreground»가 부분 문자열 비교를 항상 참으로 만드니, 낱말 단위로 비교한다.
const hasClass = (el: Element, token: string) => el.className.split(/\s+/).includes(token);
const buttonWith = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('코멘트 쓰기 팝오버(story 4831)', () => {
  it('글 칸은 바탕 Textarea(resize-none · min-h-0 · 2줄)이고 열리면 초점이 가며, 엔터는 쓴 글(공백 제거)을 보내고 시프트+엔터는 보내지 않는다', async () => {
    const onSubmit = vi.fn(async () => true);
    await mount(<CommentComposePopover onSubmit={onSubmit} onCancel={() => {}} draftTargetId="a1" />);
    await frame();
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(field.dataset.slot).toBe('textarea');
    expect(field.rows).toBe(2);
    expect(field.className).toContain('resize-none');
    expect(field.className).toContain('min-h-0');
    expect(hasClass(field, 'text-foreground')).toBe(true);
    expect(document.activeElement).toBe(field); // ref가 부품을 거쳐 네이티브 칸에 닿아 열리면 초점이 간다
    await act(async () => { setValue(field, '  핀 코멘트  '); });
    await act(async () => { key(field, 'Enter', { shiftKey: true }); });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => { key(field, 'Enter'); });
    expect(onSubmit).toHaveBeenCalledWith('핀 코멘트');
  });
});

describe('핀 설명 창(story 4831)', () => {
  it('설명 칸은 바탕 Textarea(4줄 · resize-none)이고, 저장하면 공백이 제거된 설명이 onSave로 간다', async () => {
    const onSave = vi.fn(async () => true);
    await mount(<PinAuthoringPopover open onOpenChange={() => {}} initialDescription="" onSave={onSave} draftKey={{ surface: 'spec-pin-new', targetId: 'artifact-1' }} />);
    await settle();
    const field = document.body.querySelector(`textarea[placeholder="${c.specPinDescriptionPlaceholder}"]`) as HTMLTextAreaElement;
    expect(field.dataset.slot).toBe('textarea');
    expect(field.rows).toBe(4);
    expect(field.className).toContain('resize-none');
    expect(hasClass(field, 'text-foreground')).toBe(true);
    const save = buttonWith(document.body, c.specPinSaveAction);
    expect(save.disabled).toBe(true); // 빈 설명은 저장 못 함
    await act(async () => { setValue(field, '  버튼 여백은 12px  '); });
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(onSave).toHaveBeenCalledWith('버튼 여백은 12px');
  });
});

describe('코멘트 스레드 카드 답글 칸(story 4831)', () => {
  it('답글 칸은 ds Input(flex-1)이고, 쓰고 엔터하면 스레드 id와 글이 onReply로 가고 칸이 비워진다', async () => {
    const thread = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const onReply = vi.fn();
    await mount(<CommentThreadCard thread={thread} memberMap={MOCK_MEMBERS} onReply={onReply} />);
    const input = container.querySelector(`input[placeholder="${c.replyPlaceholder}"]`) as HTMLInputElement;
    // 4910 — ds Input(글자 · 바탕 색은 ds 칸이 정하고, 옛 text-foreground / bg-background 덧칠은 없다).
    expect(input.dataset.slot).toBe('ds-input');
    expect(input.className).toContain('flex-1');
    expect(input.className).toContain('min-w-0');
    expect(hasClass(input, 'bg-background')).toBe(false);
    await act(async () => { setValue(input, '  확인했어요  '); });
    await act(async () => { key(input, 'Enter'); });
    expect(onReply).toHaveBeenCalledWith(thread.id, '확인했어요');
    expect(input.value).toBe('');
  });
});

describe('커밋 바 요약 칸(story 4831)', () => {
  it('요약 칸은 바탕 Input(flex-1)이고, 변경이 있으면 쓴 요약(공백 제거)이 onCommit으로 가며, 변경이 0이면 칸이 잠긴다', async () => {
    const onCommit = vi.fn();
    await mount(<CommitBar changeCount={2} onCommit={onCommit} />);
    const input = container.querySelector(`input[placeholder="${c.commitSummaryPlaceholder}"]`) as HTMLInputElement;
    expect(input.dataset.slot).toBe('input');
    expect(input.className).toContain('flex-1');
    expect(hasClass(input, 'text-foreground')).toBe(true);
    await act(async () => { setValue(input, '  버튼 위계 상향  '); });
    await act(async () => { buttonWith(container, c.commitAction).click(); });
    expect(onCommit).toHaveBeenCalledWith('버튼 위계 상향');
    await mount(<CommitBar changeCount={0} onCommit={onCommit} />);
    expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('속성 패널 글자 칸(story 4831)', () => {
  it('글자 칸은 바탕 Input이고 처음 값이 노드의 글자이며, 고쳐 쓰면 노드 id와 글이 onChangeText로 간다', async () => {
    const node: ArtifactNode = { id: 'n1', type: 'Button', props: { text: '다시 결제하기' }, parent_id: null, sort_order: 0 };
    const onChangeText = vi.fn();
    await mount(<PropertyPanel node={node} onChangeText={onChangeText} onDelete={() => {}} />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.dataset.slot).toBe('input');
    expect(input.value).toBe('다시 결제하기');
    expect(input.className).toContain('mb-3');
    expect(hasClass(input, 'text-foreground')).toBe(true);
    await act(async () => { setValue(input, '결제하기'); });
    expect(onChangeText).toHaveBeenCalledWith('n1', '결제하기');
  });
});

describe('산출물 뷰어 버전 고르기(story 4831)', () => {
  it('버전 칸은 바탕 Select(w-auto · shrink-0 · 바탕 면)이고 고르면 그 버전 값이 칸에 남는다', async () => {
    await mount(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />);
    const select = container.querySelector('select[data-slot="select"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.className).toContain('w-auto');
    expect(select.className).toContain('shrink-0');
    expect(select.className).toContain('bg-muted');
    expect(select.value).toBe(String(MOCK_ARTIFACT.current_version));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '3');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('3');
  });
});

describe('내보내기 창 링크 직접 선택 칸(story 4831)', () => {
  it('복사가 안 되면 나타나는 링크 칸은 바탕 Input(읽기 전용 · 모노스페이스)이고 내보낸 링크 값을 보여 주며 초점을 받으면 전체를 선택한다', async () => {
    await mount(<ExportDialog open onOpenChange={() => {}} artifactId="a1" versionNumber={1} captureTargetRef={{ current: null }} artifactFormat="html" />);
    await act(async () => { buttonWith(document.body, c.exportAction).click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { buttonWith(document.body, c.exportCopyLinkAction).click(); await Promise.resolve(); await Promise.resolve(); });
    const raw = document.body.querySelector('[data-testid="export-dialog-copy-failed-raw-link"]') as HTMLInputElement;
    expect(raw.dataset.slot).toBe('input');
    expect(raw.readOnly).toBe(true);
    expect(raw.value).toBe('https://files.example/export-1.html');
    expect(raw.className).toContain('font-mono');
    expect(hasClass(raw, 'text-foreground')).toBe(true); // 부모(내보냈어요 안내)는 흐린 글자색이라 링크 값은 본문색을 직접 가진다
    const select = vi.spyOn(raw, 'select');
    await act(async () => { raw.dispatchEvent(new FocusEvent('focus', { bubbles: false })); raw.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(select).toHaveBeenCalled();
  });
});

describe('임포트 창 HTML 붙여넣기 칸(story 4831)', () => {
  it('붙여넣기 칸은 바탕 Textarea(5줄 · resize-none · 모노스페이스)이다', async () => {
    await mount(<ImportArtifactDialog open onOpenChange={() => {}} onImport={async () => true} targetId="story-1" />);
    await vi.waitFor(() => { expect(document.body.querySelector('[data-slot="dialog-content"]')?.contains(document.activeElement)).toBe(true); });
    await act(async () => { buttonWith(document.body, 'HTML 붙여넣기').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const field = document.body.querySelector(`textarea[placeholder="${c.importHtmlPlaceholder}"]`) as HTMLTextAreaElement;
    expect(field.dataset.slot).toBe('textarea');
    expect(field.rows).toBe(5);
    expect(hasClass(field, 'text-foreground')).toBe(true);
    expect(field.className).toContain('resize-none');
    expect(field.className).toContain('font-mono');
  });
});
