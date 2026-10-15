import { describe, expect, it } from 'vitest';
import { scanContent } from './verify-no-nameless-button';

// [SID:4375] 양성 대조(스캔이 비어 공허하게 통과하지 않게 — 이번 PR이 고친 실제 모양) + 음성 대조(이름이 있거나 모르는 자리는 안 걸림).
const hits = (src: string) => scanContent(src, 'x.tsx').map((r) => `${r.kind}:${r.line}`);

describe('verify-no-nameless-button — 버튼', () => {
  it('⭐아이콘만 든 «✕» · 빈 <span/>만 든 토글 · 조건부 아이콘만 든 체크박스 · Button size=icon을 잡는다(고치기 전 goals · settings · retro · chat-input 모양)', () => {
    const src = `import { X, Check, Send } from 'lucide-react';
function A({ on, onClose }) {
  return (<div>
    <button type="button" onClick={onClose} className="rounded-xl p-1.5">
      <X className="size-4" />
    </button>
    <button type="button" onClick={onClose}><span className="absolute h-5 w-5" /></button>
    <button type="button" role="checkbox" aria-checked={on}>{on ? <Check aria-hidden /> : null}</button>
    <Button size="icon" onClick={onClose}><Send className="h-4 w-4" /></Button>
    <button onClick={onClose}><img src="a.png" alt="" /></button>
  </div>);
}`;
    expect(hits(src)).toEqual(['button:4', 'button:7', 'button:8', 'button:9', 'button:10']);
  });

  it('render={<Button/>} 트리거도 호스트로 센다 — 아이콘만이면 걸림 · 글이 render 안에 있으면 안 걸림', () => {
    const src = `import { MoreHorizontal } from 'lucide-react';
function A({ t }) {
  return (<div>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}><MoreHorizontal /></DropdownMenuTrigger>
    <DialogClose render={<Button variant="ghost">{t('cancel')}</Button>} />
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('more')} />}><MoreHorizontal /></DropdownMenuTrigger>
  </div>);
}`;
    expect(hits(src)).toEqual(['button:4']);
  });

  it('이름 속성 · 글 · sr-only 글 · 식 · 모르는 컴포넌트 · img alt · aria-hidden 버튼 · {...props}는 안 걸림', () => {
    const src = `import { X } from 'lucide-react';
function A({ t, label, onClose, props }) {
  return (<div>
    <button aria-label={t('close')} onClick={onClose}><X /></button>
    <h2 id="h">제목</h2>
    <button aria-labelledby="h" onClick={onClose}><X /></button>
    <button title={label} onClick={onClose}><X /></button>
    <button onClick={onClose}><X />닫기</button>
    <button onClick={onClose}><X /><span className="sr-only">{t('close')}</span></button>
    <button onClick={onClose}>{label}</button>
    <button onClick={onClose}><RowName id="1" /></button>
    <button onClick={onClose}><img src="a.png" alt="아바타" /></button>
    <button aria-hidden="true" tabIndex={-1} onClick={onClose} />
    <button {...props}><X /></button>
  </div>);
}`;
    expect(hits(src)).toEqual([]);
  });
});

describe('verify-no-nameless-button — 창', () => {
  it('⭐제목 · 이름 속성 없는 창을 잡는다(고치기 전 storage-delete · image-lightbox · chat-v3 맥락 시트 모양)', () => {
    const src = `function A({ t }) {
  return (<>
    <DialogContent showCloseButton={false}><div className="flex">{t('deleteTitle')}</div><StorageSourceUsageList /></DialogContent>
    <DialogPrimitive.Popup className="fixed inset-0"><span>{t('counter')}</span></DialogPrimitive.Popup>
    <SheetContent side="right"><ChatV3ContextPanel /></SheetContent>
  </>);
}`;
    expect(hits(src)).toEqual(['dialog:3', 'dialog:4', 'dialog:5']);
  });

  it('…Title · sr-only Title · aria-labelledby · aria-label · dialog-title 관례 · {...props} 창은 안 걸림', () => {
    const src = `function A({ t, id, props }) {
  return (<>
    <DialogContent><DialogHeader><DialogTitle>{t('a')}</DialogTitle></DialogHeader></DialogContent>
    <SheetContent><SheetTitle className="sr-only">{t('a')}</SheetTitle></SheetContent>
    <DialogContent aria-labelledby={id}><div id={id}>{t('a')}</div></DialogContent>
    <SheetContent aria-label={t('a')}><Panel /></SheetContent>
    <DialogContent><RecipeDetailView titleAs="dialog-title" /></DialogContent>
    <DialogContent {...props} />
  </>);
}`;
    expect(hits(src)).toEqual([]);
  });
});

// [SID:4386] PO 실측 표(PR 4765 head 3322f673f의 scanContent) — 칸마다 합성 입력. 옛 가드: A · B · D · E · G 통과(빈틈) · F 걸림(오탐).
describe('verify-no-nameless-button — story #4386 빈틈 · 오탐', () => {
  const one = (body: string) => hits(`import { X } from 'lucide-react';
function A({ t }) {
  return (<>
    ${body}
  </>);
}`);

  it.each([
    ['A · 리터럴 빈 aria-label', '<button aria-label=""><X /></button>', ['button:4']],
    ['A · 공백만인 aria-label', '<button aria-label="  "><X /></button>', ['button:4']],
    ['B · 이 파일에 없는 id를 가리키는 labelledby', '<button aria-labelledby="nope"><X /></button>', ['button:4']],
    ['D · 스스로 닫는 창', '<Dialog><DialogContent /></Dialog>', ['dialog:4']],
    ['E · 조건부(&&) 제목만 있는 창', '<DialogContent>{t && <DialogTitle>제목</DialogTitle>}<p>본문</p></DialogContent>', ['dialog:4']],
    ['E · 삼항 한쪽에만 제목', '<DialogContent>{t ? <DialogTitle>제목</DialogTitle> : null}<p>본문</p></DialogContent>', ['dialog:4']],
    ['F · 작은따옴표 aria-hidden 버튼(숨김 → 안 걸림)', "<button aria-hidden='true'><X /></button>", []],
    ['G · 작은따옴표 aria-hidden 글자는 이름 아님', "<button><span aria-hidden='true'>x</span><X /></button>", ['button:4']],
    ['대조 · 아이콘만 있는 버튼', '<button><X /></button>', ['button:4']],
    ['대조 · 이름 있는 버튼', '<button aria-label="닫기"><X /></button>', []],
  ] as const)('%s', (_label, body, expected) => {
    expect(one(body)).toEqual(expected);
  });

  it.each([
    ['labelledby가 이 파일의 id를 가리킴', '<h2 id="t1">제목</h2><button aria-labelledby="t1"><X /></button>'],
    ['labelledby 여러 id가 다 있음', '<h2 id="a">A</h2><p id="b">B</p><button aria-labelledby="a b"><X /></button>'],
    ['labelledby가 식(모름 → 이름 있다고 봄)', '<button aria-labelledby={titleId}><X /></button>'],
    ['삼항 양쪽 다 제목', '<DialogContent>{t ? <DialogTitle>가</DialogTitle> : <DialogTitle>나</DialogTitle>}</DialogContent>'],
    ['조건부 제목 + 창 aria-label', '<DialogContent aria-label="설정">{t && <DialogTitle>제목</DialogTitle>}</DialogContent>'],
    ['스스로 닫는 창 + aria-labelledby(있는 id)', '<h2 id="dt">제목</h2><DialogContent aria-labelledby="dt" />'],
    ["{'true'} aria-hidden 버튼", "<button aria-hidden={'true'}><X /></button>"],
  ] as const)('음성 대조 — %s', (_label, body) => {
    expect(one(body)).toEqual([]);
  });

  it('labelledby 여러 id 중 하나라도 없으면 건다', () => {
    expect(one('<h2 id="a">A</h2><button aria-labelledby="a missing"><X /></button>')).toEqual(['button:4']);
  });
});

