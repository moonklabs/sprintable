'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { DocEditor } from '@/components/docs/doc-editor';
import { DocGateSection } from '@/components/docs/doc-gate-section';
import { DocUrlChip } from '@/components/docs/doc-url-chip';
import { DocUrlDialog, type SlugSubmitResult } from '@/components/docs/doc-url-dialog';
import { slugifyDocTitle, isUntitledSlug, newUntitledSlug } from '@/components/docs/lib/doc-slug';
import { docsListUrl, docUrl } from '@/components/docs/lib/doc-project-url';
import { useDocSync, unwrapDocResponse } from '@/components/docs/use-doc-sync';
import { htmlToMarkdown } from '@/components/docs/lib/content-converter';
import { InlineSaveIndicator } from './inline-save-indicator';
import { DocShareDialog } from '@/components/docs/doc-share-dialog';
import { DocModeSwitch } from '@/components/docs/doc-mode-switch';
import { DocSyncBanner } from '@/components/docs/doc-sync-banner';
import { cn } from '@/lib/utils';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ds/menu';
import { IconButton } from '@/components/ds/icon-button';
import { Icon } from '@/components/ds/icon';
import { Textarea } from '@/components/ds/input';
import { useDocsLayout } from '../docs-context';
import { useToast } from '@/components/ui/toast';
import { useDocDelete } from '@/components/docs/use-doc-delete';
import { DocAssigneeControl } from '@/components/docs/doc-assignee-control';
import { DocBreadcrumb } from '@/components/docs/doc-breadcrumb';
import { useSyntheticParentTabHistory } from '@/hooks/use-synthetic-parent-tab-history';
import { HumanOnlyAction } from '@/components/ui/human-only-action';

import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { copyTextSafely } from '@/lib/clipboard';
import { useViewportClampRef } from '@/hooks/use-viewport-clamp';
import { isOutsidePress } from '@/components/shared/anchored-popover';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface DocDetail {
  id: string;
  title: string;
  slug: string;
  content: string;
  content_format?: 'markdown' | 'html';
  updated_at: string;
  parent_id?: string | null;
  icon?: string | null;
  is_folder?: boolean;
  doc_type?: string;
  org_id?: string;
  assignee_id?: string | null;
  slug_locked?: boolean;
  canonical_slug?: string;
  // E-DG S22/S28: doc decision lifecycle status(draft|pending|confirmed|denied·기본 draft) + cross-doc 대체 포인터(S28·additive).
  status?: string;
  superseded_by?: string | null;
  // #1691 payload enrich(이중 fetch 제거·additive·nullable): 담당자 요약 + 수정이력 요약 동봉.
  assignee?: { id: string; name: string; avatar_url?: string | null } | null;
  revisions?: { count: number; latest_at?: string | null } | null;
}

export default function DocSlugPage() {
  const params = useParams();
  const slug = typeof params.slug === 'string' ? params.slug : '';
  // story #1959(P2-S3): 딥링크 매니페스트(doc_detail→parentTab=all) — 콜드 진입 시 "전체"
  // 탭 루트를 BACK 대상으로 선주입. 목록에서 클릭해 온 경우(history.length>1)는 no-op.
  useSyntheticParentTabHistory('/more');
  const router = useRouter();
  const t = useTranslations('docs');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const ts = useTranslations('share');
  // 신규 문서 자동 포커스: URL ?new=1 파라미터를 ref로 처리 (useSearchParams Suspense 이슈 방지)
  const isNewRef = useRef(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('new') === '1');
  const isNew = isNewRef.current;

  const { wsSlug, projSlug, projectId, tree, setTree, pendingDocUpdate, clearPendingDocUpdate, expandFolder, openTreeDrawer } = useDocsLayout();
  const { addToast } = useToast();

  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null);
  const [docLoading, setDocLoading] = useState(true);
  const [title, setTitle] = useState('');
  // 4910 — «새 문서»로 막 만든 초안(?new=1): 서버엔 기본 제목(«제목 없음»)이 들어 있지만 그 글은 «진짜 글자»가 아니라 자리 표시여야 한다(쓰면 뒤에 붙던 결함).
  // 제목이 아직 기본 글이고 사용자가 손대기 전이면 칸은 비워 두고 기본 글은 placeholder로 보인다. 한 번이라도 고치면 평소대로(값 = 제목).
  const [titleUntouched, setTitleUntouched] = useState(true);
  const titleTouchedRef = useRef(false); // 4910 ② — 위 값의 동기 거울: 만드는 중에 제목을 손댔는지(비운 것도 손댄 것) — 응답이 와도 사용자가 비운 칸을 되살리지 않는다.
  const slugRetriesRef = useRef(0);
  // 4910 ② «첫 저장 때 만들기» — 「새 문서」는 서버에 아무것도 안 만들고 임시 주소(`untitled-…?new=1`)의 초안 화면으로만 온다(docs-client-layout.createDoc). 그 주소에 문서가 없으면(404) 이 화면은 «초안 모드»:
  // 서버 문서(selectedDoc) 없이 편집기만 뜨고, 첫 «쓴 것»(제목 한 글자 · 내용 비공백)에서 문서를 한 번 만든다. 그 뒤는 예전과 같은 PATCH 자동저장 길.
  const [draft, setDraft] = useState<{ slug: string; parentId: string | null } | null>(null);
  const [draftCreating, setDraftCreating] = useState(false);
  const [adoptSnapshot, setAdoptSnapshot] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const [content, setContent] = useState('');
  const [contentFormat, setContentFormat] = useState<'markdown' | 'html'>('markdown');
  const [autosave, setAutosave] = useState(true);
  const [mdCopied, setMdCopied] = useState(false);
  // story #3986(클래스 «거짓 성공 표시») — 옛 코드는 clipboard 실패를 삼키고도
  // 무조건 setMdCopied(true)를 실행했다. 문서 내용은 에디터에 이미 선택 가능하게
  // 떠 있어 별도 노출 블록은 불요 — 아이콘 버튼 title/aria-label만 실패 문구로.
  const [mdCopyFailed, setMdCopyFailed] = useState(false);
  // story #3986 CHANGES(페드루 PO C2·C3) — 에디터가 그리는 건 렌더링 결과지 markdown
  // 원문이 아니다(html 문서는 변환 결과라 원문과 다르다). 실패했을 때만 실제로
  // 클립보드에 보내려던 markdown을 선택 가능하게 보여준다.
  const [mdCopyFailedRaw, setMdCopyFailedRaw] = useState<string | null>(null);
  const mdCopyFailedPanelRef = useRef<HTMLDivElement>(null);
  const mdCopyFailedClampRef = useViewportClampRef<HTMLDivElement>(); // story #4342 — 좁은 화면 뷰포트 안으로
  const [slugLocked, setSlugLocked] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // §3-2 슬림 헤더 메타: 수정 이력 N. #1691 payload enrich로 별도 /revisions fetch 제거 — doc payload의
  // revisions.count 직접 소비(미enrich/legacy 응답엔 null → 메타 서브라인 숨김·기존 동작 동일).
  // (DocGateSection의 revision 타임라인 fetch는 full history용이라 별개·유지.)
  const revisionCount = selectedDoc?.revisions?.count ?? null;
  // story 4906 — «revisions» are the saved copies of a version that was REJECTED and then taken back to a draft to be fixed (backend DocRevision: one snapshot on denied → draft), not a count of
  // saves: three saves of a fresh doc are 0, correctly. «수정 이력 0 / 0 revisions» read as «0 edits» (a customer saved three times and saw 0). The header now says what the number is
  // («이전 판 N개 / N earlier versions») and says nothing while there is none (the reading header already hid the zero).

  const handleDocSaved = useCallback((doc: DocDetail) => {
    setSelectedDoc(doc);
    setTree((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: doc.title, slug: doc.slug } : d)));
    if (typeof doc.slug_locked === 'boolean') setSlugLocked(doc.slug_locked);
    // Slug auto-derived / canonicalized server-side → move the URL to the canonical slug.
    if (doc.slug && doc.slug !== slug) {
      router.replace(docUrl(wsSlug, projSlug, doc.slug));
    }
  }, [setTree, slug, router, wsSlug, projSlug]);

  const handleTitleChange = useCallback((value: string) => {
    setTitleUntouched(false);
    titleTouchedRef.current = true;
    setTitle(value);
    setSelectedDoc((prev) => (prev ? { ...prev, title: value } : null));
    setTree((prev) => prev.map((d) => (d.id === selectedDoc?.id ? { ...d, title: value } : d)));
  }, [selectedDoc?.id, setTree]);

  // AC1: while a new doc still carries its `untitled-<ts>` slug and the user has not
  // manually locked it, derive the slug from the title and send it in the same save as
  // the title. The BE silently de-duplicates with a `-N` suffix (auto path never 422s)
  // and returns the canonical slug, which handleDocSaved moves the URL to. An empty
  // derivation (emoji/symbols only) skips the slug entirely so the doc keeps untitled.
  const shouldAutoDeriveSlug = selectedDoc !== null && !slugLocked && isUntitledSlug(selectedDoc.slug);
  const derivedSlug = shouldAutoDeriveSlug ? slugifyDocTitle(title) : '';

  const { status: saveStatus, isDirty, save, clearSyncAlerts, adoptNormalized } = useDocSync<DocDetail>({
    docId: selectedDoc?.id ?? null,
    savePayload: derivedSlug
      ? { title, content, content_format: contentFormat, slug: derivedSlug, slug_locked: false }
      : { title, content, content_format: contentFormat },
    serverUpdatedAt: selectedDoc?.updated_at ?? null,
    editing: selectedDoc !== null,
    autosave,
    onSaved: handleDocSaved,
    adoptBaselineSnapshot: adoptSnapshot, // 4910 ② — 막 만든 문서의 기준선 = 만들 때 보낸 값(생성 중 친 글자가 «저장됨»으로 사라지지 않게)
  });

  const handleNormalize = useCallback((value: string) => {
    setContent(value);
    adoptNormalized({ content: value });
  }, [adoptNormalized]);

  const fetchDoc = useCallback(async () => {
    if (!projectId || !slug) return;
    setDocLoading(true);
    try {
      // AC3 (fc4d4264): never serve the doc body from HTTP/bf cache — a stale load
      // re-seeds the editor with an outdated baseline and can re-trigger an overwrite.
      const res = await fetchWithAuth(`/api/docs?project_id=${projectId}&slug=${slug}`, { cache: 'no-store' });
      if (!res.ok) {
        // 4910 ② — 임시 주소(`untitled-…`)에 `?new=1`로 왔는데 문서가 없으면(404) 서버에 아직 안 만든 «새 문서 초안»이다(오류가 아님). 그 밖의 404는 아래 옛 회복 그대로(목록으로).
        if (res.status === 404 && isNew && isUntitledSlug(slug)) {
          setDraft({ slug, parentId: new URLSearchParams(window.location.search).get('parent') || null });
          return;
        }
        // prod P0(2026-07-14) — 이전엔 setSelectedDoc(null)만 하고 끝나 이 슬러그가 현재
        // project_id에 없는(삭제됐든, project 전환 레이스로 어긋났든) 모든 경우가 회복 경로
        // 없는 "문서를 찾을 수 없습니다" 정적 화면에 영구 고립됐다 — 새로고침도 같은
        // project_id+slug 조합을 그대로 재질의할 뿐이라 무효(라이브 재현 완료). 이 slug가
        // 지금 projectId엔 없다는 사실은 원인이 뭐든 동일하므로, 살아있는 목록으로 되돌려
        // 회복 경로를 준다(진짜 없는 문서를 억지로 보여주지 않으면서도 dead-end는 피한다).
        // story a539c649 S2: 이 회복 자체는 여전히 유효(project 안에 그 slug가 진짜 없는 경우
        // 대응) — 소거된 건 "잘못된 project로 재질의"였던 원인(#2154), 이 증상 대응 코드는 유지.
        router.replace(docsListUrl(wsSlug, projSlug));
        return;
      }
      const json = await res.json();
      const data = json?.data ?? null;
      if (!data) {
        router.replace(docsListUrl(wsSlug, projSlug));
        return;
      }
      setSelectedDoc(data);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
      setContentFormat(data.content_format ?? 'markdown');
      setSlugLocked(data.slug_locked ?? false);
      // AC3: the request resolved via an old/alias slug → canonicalize the URL so
      // bookmarks and internal links settle on the live address (BE sends canonical_slug).
      const canonical = data.canonical_slug ?? data.slug;
      if (canonical && canonical !== slug) router.replace(docUrl(wsSlug, projSlug, canonical));
    } catch {
      setSelectedDoc(null);
    } finally {
      setDocLoading(false);
    }
  }, [projectId, slug, router, wsSlug, projSlug, isNew]);

  useEffect(() => { void fetchDoc(); }, [fetchDoc]);

  // 4910 — 막 만든 초안의 제목칸(위 titleUntouched): 서버에 들어 있는 기본 글은 값이 아니라 placeholder로만 보인다.
  const defaultTitle = t('newDocDefaultTitle');
  const brandNewTitle = isNew && titleUntouched && title === defaultTitle;

  // 4910 ② — 초안 모드에서 «쓴 것»이 생기면 문서를 한 번 만든다(single-flight). 제목 = 쓴 글, 비었으면 기본 글. 슬러그 = 임시 슬러그(제목에서 파생은 만든 뒤 예전 PATCH 길이 한다).
  const isDraft = selectedDoc === null && draft !== null;
  const draftHasText = isDraft && (title.trim() !== '' || content.trim() !== '');
  const createDraftDoc = useCallback(async (): Promise<boolean> => {
    if (!draft || selectedDoc || creatingRef.current || !projectId) return false;
    if (title.trim() === '' && content.trim() === '') return false;
    creatingRef.current = true;
    setDraftCreating(true);
    const postedTitle = title.trim() === '' ? defaultTitle : title;
    const posted = { title: postedTitle, content, content_format: contentFormat };
    try {
      const res = await fetchWithAuth('/api/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...posted, slug: draft.slug, parent_id: draft.parentId }),
      });
      if (res.status === 409 && slugRetriesRef.current < 3) {
        // 임시 슬러그가 이미 쓰인 경우(무작위 꼬리로 사실상 없지만): 같은 요청을 되풀이하지 않고 새 임시 슬러그로 다음 박자에 다시 만든다. 글은 화면 상태에 그대로 있다.
        // 주소는 옮기지 않는다 — 동적 구간(slug)이 바뀌면 이 쪽이 새로 서서 쓴 글(상태)이 사라진다. 만든 뒤 주소 ≠ 문서 슬러그인 채로 남는 건 알려진 한계(PR 본문): 첫 PATCH가 슬러그를 파생하면 handleDocSaved가 주소를 맞춘다.
        slugRetriesRef.current += 1;
        setDraft({ slug: newUntitledSlug(), parentId: draft.parentId });
        return false;
      }
      if (!res.ok) throw new Error('Failed to create doc');
      const { data } = await res.json();
      // 기준선 = 보낸 값. 응답 오기 전에 더 친 글자는 보낸 값과 달라 dirty가 되어 다음 자동저장이 보낸다.
      setAdoptSnapshot(JSON.stringify(posted));
      setSelectedDoc(data as DocDetail);
      // 제목을 한 번도 안 건드렸을 때만 기본 글을 되돌려 놓는다(만드는 중에 비운 칸은 비운 채로).
      if (!titleTouchedRef.current) setTitle((cur) => (cur === '' ? postedTitle : cur));
      setDraft(null);
      setTree((prev) => [{ id: data.id, parent_id: data.parent_id || null, title: data.title, slug: data.slug, icon: data.icon || null, sort_order: data.sort_order || 0, is_folder: data.is_folder || false, updated_at: data.updated_at } as (typeof prev)[number], ...prev]);
      return true;
    } catch {
      addToast({ title: t('createFailed'), type: 'error' });
      return false;
    } finally {
      creatingRef.current = false;
      setDraftCreating(false);
    }
  }, [draft, selectedDoc, projectId, title, content, contentFormat, defaultTitle, setTree, addToast, t]);
  // 자동저장과 같은 박자(디바운스 1.5초). 만들기가 실패하면 값이 그대로라 다시 안 돈다 — 다음 입력 또는 «저장»이 다시 시도한다.
  useEffect(() => {
    if (!isDraft || !autosave || !draftHasText) return;
    const timer = window.setTimeout(() => { void createDraftDoc(); }, 1500);
    return () => window.clearTimeout(timer);
  }, [isDraft, autosave, draftHasText, createDraftDoc]);
  // 나갈 때(화면 이동): 쓴 것이 있는데 아직 안 만들었으면 지금 만든다 — 만들기는 지우는 길이 아니라 최악에도 «쓴 글이 문서로 남는» 쪽이다. 탭 닫기 · 새로고침은 아래 beforeunload 경고.
  const flushDraftRef = useRef<() => void>(() => {});
  useEffect(() => { flushDraftRef.current = () => { if (draftHasText) void createDraftDoc(); }; });
  useEffect(() => () => flushDraftRef.current(), []);
  // 저장 안 된 글이 있을 때(아직 안 만든 초안 + 쓴 것 · 만드는 중) 탭을 닫거나 새로고침하면 브라우저가 한 번 묻는다. (이 편집기에는 이 경고가 원래 없었다 — 만든 뒤의 문서는 이 PR 밖.)
  useEffect(() => {
    if (!(draftHasText || draftCreating)) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draftHasText, draftCreating]);

  // FIX-4 off-ramp (fc4d4264): resolve a conflict / remote-changed dead-end.
  // Pull re-fetches the live doc (fetchDoc is no-store, AC-F4-7) → the serverUpdatedAt
  // effect in useDocSync realigns the baseline + clears the latch; clearSyncAlerts is
  // the explicit belt-and-suspenders so the banner dismisses immediately.
  const handlePull = useCallback(async () => {
    await fetchDoc();
    clearSyncAlerts('saved');
  }, [fetchDoc, clearSyncAlerts]);

  // Overwrite is the only force path — the banner confirms before calling this, and
  // autosave/retry never force (FIX-2 invariant).
  const handleOverwrite = useCallback(() => {
    void save({ force: true });
  }, [save]);

  // layout handleRename PATCH 성공 후 updated_at 동기화 — useDocSync 기준선 desync 방지
  useEffect(() => {
    if (!pendingDocUpdate || !selectedDoc || pendingDocUpdate.id !== selectedDoc.id) return;
    setSelectedDoc((prev) => prev ? { ...prev, title: pendingDocUpdate.title, updated_at: pendingDocUpdate.updated_at } : null);
    setTitle(pendingDocUpdate.title);
    clearPendingDocUpdate();
  }, [pendingDocUpdate, selectedDoc, clearPendingDocUpdate]);

  const handleCopyMarkdown = useCallback(async () => {
    const md = contentFormat === 'markdown' ? content : htmlToMarkdown(content);
    const result = await copyTextSafely(md);
    if (!result.ok) {
      setMdCopyFailed(true);
      setMdCopyFailedRaw(md);
      window.setTimeout(() => setMdCopyFailed(false), 3000);
      return;
    }
    setMdCopyFailed(false);
    setMdCopyFailedRaw(null);
    setMdCopied(true);
    window.setTimeout(() => setMdCopied(false), 1600);
  }, [content, contentFormat]);

  // story #3986 CHANGES(페드루 PO 2회차) — mdCopyFailed(아이콘/aria용 3초 코스메틱
  // 플래그)와 원문 노출 칸을 분리했다(패널 자체는 mdCopyFailedRaw만으로 뜬다). 손으로
  // 고를 시간을 3초로 자르지 않되, 그렇다고 화면에 영영 안 사라지면 안 되니 다음
  // 성공(핸들러 안)·바깥 클릭·Esc로 닫는다.
  useEffect(() => {
    if (mdCopyFailedRaw == null) return;
    const onPointerDown = (e: MouseEvent) => {
      // 이 화면은 포털 팝오버(목차 · 담당자 «더 보기»)를 품는다 — 바깥 판정은 공용 규칙 하나(#4349 PR 2 · 가드 outside-press).
      if (isOutsidePress(mdCopyFailedPanelRef.current, e.target)) setMdCopyFailedRaw(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMdCopyFailedRaw(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mdCopyFailedRaw]);

  // story 4892 (UI-9 §5 #4) — a failed delete is an error toast (it was swallowed by an empty catch).
  const handleDelete = useDocDelete({ docId: selectedDoc?.id, projectId, wsSlug, projSlug, router, setTree });

  // AC2: explicit slug edit. Locks the slug (slug_locked: true) so auto-derivation
  // stops, and surfaces BE conflicts (409 → suggested -N) / format errors (422).
  const handleSubmitSlug = useCallback(async (newSlug: string): Promise<SlugSubmitResult> => {
    if (!selectedDoc) return { ok: false, code: 'invalid' };
    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSlug, slug_locked: true }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => null) as { error?: { suggestion?: string } } | null;
        return { ok: false, code: 'taken', suggestion: body?.error?.suggestion };
      }
      if (res.status === 422) return { ok: false, code: 'invalid' };
      if (!res.ok) return { ok: false, code: 'invalid' };
      // Same raw-proxy envelope class as the autosave path: docs PATCH is a raw
      // proxyToFastapi passthrough, so the body is the bare DocResponse — reading
      // `json.data` yielded undefined → BE-success slug edits surfaced as 'invalid'
      // and the derive nudge no-op'd (live since #1374). Reuse unwrapDocResponse.
      const { doc: data } = unwrapDocResponse<DocDetail>(await res.json());
      handleDocSaved(data);
      return { ok: true };
    } catch {
      return { ok: false, code: 'invalid' };
    }
  }, [selectedDoc, handleDocSaved]);

  // 권고1 (가디언): one-click derive for docs that have a title but still carry a
  // stale untitled-* slug (created before this feature). Auto-derive (AC1) only
  // fires on a title edit, so this nudge is the affordance that targets the
  // "untitled 잔존" report directly. Auto path (slug_locked:false) → BE silently de-dupes.
  const handleDeriveFromTitle = useCallback(async () => {
    if (!selectedDoc) return;
    const derived = slugifyDocTitle(title);
    if (!derived) return;
    try {
      const res = await fetch(`/api/docs/${selectedDoc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: derived, slug_locked: false }),
      });
      if (res.ok) {
        // Raw-proxy envelope class (see handleSubmitSlug) — un-envelope the bare DocResponse.
        const { doc: data } = unwrapDocResponse<DocDetail>(await res.json());
        handleDocSaved(data);
      }
    } catch { /* derive failed — doc keeps its untitled slug */ }
  }, [selectedDoc, title, handleDocSaved]);

  const handleNavigate = useCallback((targetSlug: string) => {
    // story 4892 (D1) — a [[wiki link]] / page embed clicked inside the editor opens the target to READ, like every other document link
    router.push(`${docUrl(wsSlug, projSlug, targetSlug)}/view`);
  }, [router, wsSlug, projSlug]);

  if (docLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-ds-small text-ds-ink-3">{t('loading')}</p>
      </div>
    );
  }

  if (!selectedDoc && !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="break-keep text-ds-small text-ds-ink-3">{t('notFound')}</p>
      </div>
    );
  }

  const docActions = !selectedDoc ? (
    <InlineSaveIndicator status={draftCreating ? 'saving' : draftHasText ? 'unsaved' : 'idle'} onAction={() => { void createDraftDoc(); }} t={t} tc={tc} />
  ) : (
    <>
      <InlineSaveIndicator status={saveStatus} onAction={save} t={t} tc={tc} />
      <div className="relative">
        {/* story 4892 (UI-9 문서 상세 열) — 도구 줄 단추 = ds IconButton(lg 이상에서만 · 그 아래는 ⋯ 메뉴 안). 복사 성공 = 체크 · 실패 = 실패 색 아이콘(이름 · title이 실패 문구로 바뀜 — 그대로). */}
        <IconButton
          icon={mdCopied ? 'check' : 'content_copy'}
          label={mdCopyFailed ? tc('copyFailedSelectManually') : t('copyMarkdown')}
          onClick={handleCopyMarkdown}
          className={cn('hidden lg:inline-flex', mdCopied && 'text-ds-done', mdCopyFailed && 'text-ds-failed')}
          data-testid="docs-toolbar-copy-markdown"
        />
        {/* story #3986 CHANGES(페드루 PO C2·C3) — 아이콘 버튼만으론 실패가 안 보였다
            (title·aria-label·아이콘 색만 바뀜 — 터치 기기는 title도 못 봄). 눈에 보이는
            role=alert + markdown 원문 선택 칸을 드롭다운으로 띄운다. 패널 자체는
            mdCopyFailed(3초 코스메틱)와 분리해 mdCopyFailedRaw만으로 뜬다 — 손으로
            고를 시간을 3초로 자르지 않는다(다음 성공·바깥 클릭·Esc·✕로 닫는다). */}
        {mdCopyFailedRaw != null ? (
          <div ref={(el) => { mdCopyFailedPanelRef.current = el; mdCopyFailedClampRef(el); }} data-dropdown-panel="md-copy-failed" className="absolute right-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1rem)] space-y-1.5 rounded-ds-panel border border-ds-line-control bg-ds-surface-raised p-2 shadow-md">
            <div className="flex items-start justify-between gap-2">
              <p role="alert" className="break-keep text-ds-small text-ds-failed">{tc('copyFailedSelectManually')}</p>
              <IconButton icon="close" label={tc('close')} onClick={() => setMdCopyFailedRaw(null)} className="shrink-0" />
            </div>
            <Textarea
              readOnly
              value={mdCopyFailedRaw}
              onFocus={(e) => e.currentTarget.select()}
              className="resize-none p-1.5 font-mono lg:text-xs"
              rows={4}
              data-testid="docs-copy-markdown-failed-raw"
            />
          </div>
        ) : null}
      </div>
      {/* story 4892 (UI-9 상세 열) — the icon-only «미리보기» eye (and the reader's separate «편집» link) is now ONE labelled pair «읽기 | 고치기»,
          in the same header place on both screens. The old story-#2967 note: the reader entry must stay discoverable — it is now a visible word. */}
      <DocModeSwitch
        mode="edit"
        readHref={`${docUrl(wsSlug, projSlug, slug)}/view`}
        editHref={docUrl(wsSlug, projSlug, slug)}
        readLabel={t('modeRead')}
        editLabel={t('editDoc')}
        groupLabel={t('modeSwitchLabel')}
      />
      <IconButton icon="share" label={ts('share')} onClick={() => setShareDialogOpen(true)} className="hidden lg:inline-flex" data-testid="docs-toolbar-share" />
      {/* story 4892 — ⋯ 메뉴 = ds Menu(읽기 화면과 같은 부품). 항목 · 이름 · 규칙은 그대로(공유 · 복사는 lg 미만 전용 · 읽기 전용 문서엔 주소 바꾸기 · 삭제 없음 · 삭제는 사람만). */}
      <Menu>
        <MenuTrigger aria-label={t('moreActions')} className="inline-flex size-7 items-center justify-center rounded-ds-control text-ds-ink-2 transition-colors outline-none hover:bg-ds-surface-high hover:text-ds-ink focus-visible:ring-2 focus-visible:ring-ds-action touch:size-11">
          <Icon name="more_horiz" size={16} />
        </MenuTrigger>
        <MenuContent align="end" className="w-48">
          {/* story #4361(유나 실측 390/360) — 도구 줄 오른쪽 무리가 편집 카드(overflow-hidden) 밖으로 밀려 폰에서 «공유» · «⋯»(360은
              «마크다운 복사»까지)를 누를 길이 없었다. `lg` 미만(GNB가 모바일 모양인 폭 — 웹 규칙 `md` 금지)에서는 두 버튼을 도구 줄에서
              빼고 이 메뉴 안에서 같은 동작 · 같은 이름으로. 복사 실패 패널은 버튼을 감싼 칸에 그대로 떠서 여기서 눌러도 보인다. */}
          <MenuItem className="lg:hidden" icon="content_copy" onClick={() => void handleCopyMarkdown()} data-testid="docs-menu-copy-markdown">
            {t('copyMarkdown')}
          </MenuItem>
          <MenuItem className="lg:hidden" icon="share" onClick={() => setShareDialogOpen(true)} data-testid="docs-menu-share">
            {ts('share')}
          </MenuItem>
          {selectedDoc.doc_type !== 'sprint_report' && <MenuSeparator className="lg:hidden" />}
          {selectedDoc.doc_type !== 'sprint_report' && (
            <>
              <MenuItem icon="link" onClick={() => setUrlDialogOpen(true)}>
                {t('editUrl')}
              </MenuItem>
              <MenuSeparator />
              {/* story #2104 — BE docs.py:471이 human-only로 삭제를 403 거부한다(delete는 사람만
                  가능, 되돌릴 수 없는 조작). 에이전트 계정에도 이 항목을 열어두면 "내가 지울 수
                  있다"고 믿게 만드는 #2091/#2103과 같은 결함이라 미리 숨긴다(메뉴 공간 제약상
                  사유 문구 대신 항목 자체를 생략 — edit-url 등 남은 항목은 그대로 유지). */}
              <HumanOnlyAction>
                <MenuItem variant="danger" icon="delete" onClick={handleDelete}>
                  {t('deleteDoc')}
                </MenuItem>
              </HumanOnlyAction>
            </>
          )}
        </MenuContent>
      </Menu>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 박스1: Dispatch(담당자) 밴드 제거 → 슬림 헤더 담당자 아바타+popover로 이동(content-dominant·기능 보존). */}

      {/* S28: doc decision gate(검토 상태·반려 사유·재상신 CTA·revision 이력). 비-gated/이력없음은 self-hide. */}
      {selectedDoc && selectedDoc.doc_type !== 'sprint_report' ? (
        <div className="flex-shrink-0 px-4 pt-2 lg:px-6">
          <DocGateSection docId={selectedDoc.id} status={selectedDoc.status} onTransitioned={fetchDoc} />
        </div>
      ) : null}

      {/* Editor */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-2 pb-4 lg:px-6 lg:pt-3 lg:pb-6 lg:group-data-[collapsed=true]/docs:pl-14">
        <DocEditor
          value={content}
          contentFormat={contentFormat}
          editable={selectedDoc?.doc_type !== 'sprint_report'}
          currentDocId={selectedDoc?.id}
          // story #3866(발견 즉시 수정) — projectId가 DocEditor 최상위 prop으로 한 번도 안
          // 넘어오고 있었다(dispatchSlot 안 DocAssigneeControl에만 있었음). 기존 wikiLink
          // `[[` 검색(WikiLinkNode.configure({projectId})) 도 이 페이지에서 이미 항상
          // projectId=undefined로 죽어 있던 잠복 결함 — 신규 `#` 스토리 검색과 같은
          // 원인이라 같이 고친다(별 카드 0, "발견 즉시 수정" 규율).
          projectId={projectId}
          onNavigate={handleNavigate}
          onChange={setContent}
          // story #4339(AC7) — 편집 없이 편집기가 다듬은 값 = 깨끗한 기준(쓰기 없음) · 입력했다 지우면 이 값으로 돌아와 dirty가 풀린다.
          onNormalize={handleNormalize}
          onContentFormatChange={setContentFormat}
          isDirty={selectedDoc ? isDirty : draftHasText || draftCreating}
          onSave={selectedDoc ? save : createDraftDoc}
          autosave={autosave}
          onAutosaveToggle={setAutosave}
          title={brandNewTitle ? '' : title}
          onTitleChange={handleTitleChange}
          titlePlaceholder={brandNewTitle || (isDraft && titleUntouched) ? defaultTitle : t('titlePlaceholder')}
          titleAutoFocus={isNew || !title}
          onOpenTree={openTreeDrawer}
          dispatchSlot={projectId && selectedDoc ? (
            <DocAssigneeControl
              docId={selectedDoc.id}
              projectId={projectId}
              currentAssigneeId={selectedDoc.assignee_id ?? null}
              assigneeName={selectedDoc.assignee?.name ?? null}
              onAssigneePatched={(aid) => setSelectedDoc((prev) => prev ? { ...prev, assignee_id: aid } : prev)}
            />
          ) : undefined}
          metaSlot={
            <>
              {revisionCount != null && revisionCount > 0 ? (
                <>
                  <span className="tabular-nums">{t('docMetaRevisions', { count: revisionCount })}</span>
                  {selectedDoc?.updated_at ? <span aria-hidden> · </span> : null}
                </>
              ) : null}
              {selectedDoc?.updated_at ? (
                <span className="tabular-nums">{formatViewerRelativeTime(selectedDoc.updated_at, locale, displayTimezone)}</span>
              ) : null}
            </>
          }
          urlSlot={
            <DocUrlChip
              slug={selectedDoc?.slug ?? draft?.slug ?? slug}
              onEdit={selectedDoc && selectedDoc.doc_type !== 'sprint_report' ? () => setUrlDialogOpen(true) : undefined}
              onDeriveFromTitle={selectedDoc && selectedDoc.doc_type !== 'sprint_report' && slugifyDocTitle(title) ? handleDeriveFromTitle : undefined}
              labels={{ editUrl: t('editUrl'), slugNudge: t('slugNudge') }}
            />
          }
          breadcrumb={
            tree.length > 0 && selectedDoc ? (
              <DocBreadcrumb
                currentDocId={selectedDoc.id}
                tree={tree}
                onExpandFolder={expandFolder}
                ariaLabel={t('breadcrumbAriaLabel')}
              />
            ) : null
          }
          actions={docActions}
          syncBanner={
            saveStatus === 'conflict' || saveStatus === 'remote-changed' ? (
              <DocSyncBanner
                status={saveStatus}
                isDirty={isDirty}
                onPull={handlePull}
                onOverwrite={handleOverwrite}
                onDismiss={() => clearSyncAlerts(isDirty ? 'unsaved' : 'idle')}
                labels={{
                  title: saveStatus === 'conflict' ? t('statusConflict') : t('statusRemoteChanged'),
                  pull: t('conflictReload'),
                  overwrite: t('conflictOverwrite'),
                  keepEditing: t('syncKeepEditing'),
                  discardWarning: t('syncDiscardWarning'),
                  overwriteConfirm: t('syncOverwriteConfirm'),
                }}
              />
            ) : null
          }
          labels={{
            contentFormat: t('contentFormat'),
            markdown: t('formatMarkdown'),
            preview: t('formatPreview'),
            save: t('save'),
            toolbar: t('toolbar'),
            placeholder: t('editorPlaceholder'),
            h1: t('toolbarH1'),
            h2: t('toolbarH2'),
            bold: t('toolbarBold'),
            italic: t('toolbarItalic'),
            bullet: t('toolbarBullet'),
            quote: t('toolbarQuote'),
            code: t('toolbarCode'),
            link: t('toolbarLink'),
            autosave: t('autosave'),
            undo: t('toolbarUndo'),
            redo: t('toolbarRedo'),
          }}
        />
      </div>

      {selectedDoc ? (
      <DocUrlDialog
        open={urlDialogOpen}
        onClose={() => setUrlDialogOpen(false)}
        currentSlug={selectedDoc.slug}
        title={title}
        onSubmit={handleSubmitSlug}
        labels={{
          editUrl: t('editUrl'),
          urlDialogDesc: t('urlDialogDesc'),
          deriveFromTitle: t('deriveFromTitle'),
          aliasNote: t('aliasNote'),
          slugTaken: t('slugTaken'),
          slugInvalid: t('slugInvalid'),
          save: t('save'),
          cancel: tc('cancel'),
        }}
      />
      ) : null}

      {selectedDoc ? (
      <DocShareDialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        docId={selectedDoc.id}
        labels={{
          share: ts('share'),
          shareToWeb: ts('shareToWeb'),
          shareToWebDesc: ts('shareToWebDesc'),
          copyLink: ts('copyLink'),
          linkCopied: ts('linkCopied'),
          stopSharing: ts('stopSharing'),
          regenerateLink: ts('regenerateLink'),
          shareSingleDocNote: ts('shareSingleDocNote'),
        }}
      />
      ) : null}
    </div>
  );
}
