import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { formatFileSize } from './file-node';

const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB — images are compressed above this
const MAX_DIM = 1920;
// Storage 업로드 상한 — BE 라우트(100MB)와 정합. base64 인라인 시절의 5MB 제한은 storage 전환으로 해제.
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function dispatchFileSizeError(file: File): void {
  window.dispatchEvent(new CustomEvent('docs:file-size-error', {
    detail: { message: `파일 크기가 100MB를 초과합니다. (${formatFileSize(file.size)})` },
  }));
}

// ─── Compression (이미지 >1MB canvas 축소, MAX_DIM 1920) — base64 인라인 대신 업로드용 Blob/File 반환 ─────
async function processImageFileToBlob(file: File): Promise<File> {
  if (file.size <= MAX_IMAGE_BYTES) return file;
  return new Promise<File>((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(file);
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onerror = () => resolve(file);
      img.onload = () => {
        let { naturalWidth: w, naturalHeight: h } = img;
        if (w > MAX_DIM || h > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }
            const base = file.name.replace(/\.[^.]+$/, '');
            resolve(new File([blob], `${base}.jpg`, { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.85,
        );
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

// ─── Upload + register ────────────────────────────────────────────────────────
export interface AssetRef {
  assetId: string;
  filename: string;
  size: number;
  mime: string;
}

/**
 * S4: (1) multipart 업로드 → {url,name,content_type,size}
 *     (2) register → { data: { assetId } } (또는 {id}). assetId(ref) 반환.
 * register 엔드포인트는 design-first(디디) — 미존재 시 non-2xx 로 throw 되어 호출부가 error 상태 처리.
 */
async function uploadAndRegister(docId: string, file: File): Promise<AssetRef> {
  const fd = new FormData();
  fd.append('file', file);
  const up = await fetch(`/api/docs/${docId}/attachments`, { method: 'POST', body: fd });
  if (!up.ok) throw new Error('upload failed');
  const meta = (await up.json()) as { url: string; name: string; content_type: string; size: number };

  const reg = await fetch(`/api/docs/${docId}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object_path: meta.url,
      url: meta.url,
      filename: meta.name,
      size: meta.size,
      mime: meta.content_type,
    }),
  });
  if (!reg.ok) throw new Error('register failed');
  const json = (await reg.json().catch(() => null)) as
    | { data?: { assetId?: string; id?: string } | null; assetId?: string; id?: string }
    | null;
  const assetId =
    json?.data?.assetId ?? json?.data?.id ?? json?.assetId ?? json?.id ?? null;
  if (!assetId) throw new Error('no assetId in register response');
  return { assetId, filename: meta.name, size: meta.size, mime: meta.content_type };
}

// ─── Optimistic node swap (uploadId 추적) ──────────────────────────────────────
function updateNodeByUploadId(
  view: EditorView,
  uploadId: string,
  patch: Record<string, unknown>,
): void {
  let target: { pos: number; attrs: Record<string, unknown> } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (target) return false;
    if (node.attrs['uploadId'] === uploadId) {
      target = { pos, attrs: { ...node.attrs } };
      return false;
    }
    return true;
  });
  if (!target) return;
  const t = target as { pos: number; attrs: Record<string, unknown> };
  const tr = view.state.tr.setNodeMarkup(t.pos, undefined, { ...t.attrs, ...patch });
  // 옵티미스틱 swap 은 undo 스택 오염 방지.
  view.dispatch(tr.setMeta('addToHistory', false));
}

// docId provider 레지스트리 — editor 인스턴스별 라이브 getter(doc 전환 대응).
// storage mutate(immutability)·ref 전달(refs rule) 둘 다 회피하려 모듈 WeakMap 사용.
const docIdProviders = new WeakMap<Editor, () => string | undefined>();

/** doc-editor 가 effect 에서 호출 — 현재 docId getter 등록. cleanup 반환. */
export function registerDocIdProvider(editor: Editor, getDocId: () => string | undefined): () => void {
  docIdProviders.set(editor, getDocId);
  return () => {
    if (docIdProviders.get(editor) === getDocId) docIdProviders.delete(editor);
  };
}

function resolveDocId(editor: Editor): string | undefined {
  return docIdProviders.get(editor)?.();
}

// 실패 후 "다시 시도" 를 위해 원본 File 을 uploadId 로 보관(성공 시 제거).
const pendingFiles = new Map<string, File>();

function newUploadId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `u_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// 업로드+register 실행 → 성공/실패에 따라 노드 swap. (insert 는 호출부에서 선행.)
async function performUpload(editor: Editor, file: File, uploadId: string): Promise<void> {
  const docId = resolveDocId(editor);
  const { view } = editor;
  const isImage = file.type.startsWith('image/');
  if (!docId) {
    updateNodeByUploadId(view, uploadId, { uploading: false, uploadError: true });
    return;
  }
  try {
    const toUpload = isImage ? await processImageFileToBlob(file) : file;
    const ref = await uploadAndRegister(docId, toUpload);
    pendingFiles.delete(uploadId);
    if (isImage) {
      updateNodeByUploadId(view, uploadId, {
        src: null,
        assetId: ref.assetId,
        filename: ref.filename,
        size: ref.size,
        mime: ref.mime,
        uploading: false,
        uploadError: false,
        uploadId: null,
      });
    } else {
      updateNodeByUploadId(view, uploadId, {
        data: '',
        assetId: ref.assetId,
        filename: ref.filename,
        size: ref.size,
        mimeType: ref.mime,
        uploading: false,
        uploadError: false,
        uploadId: null,
      });
    }
  } catch {
    // uploadId 유지 → error 카드의 "다시 시도" 가능.
    updateNodeByUploadId(view, uploadId, { uploading: false, uploadError: true });
  }
}

/**
 * 진입 통합 — gutter "+"·slash·DnD·paste 가 모두 이 함수로 라우팅.
 * (a) 옵티미스틱 노드 즉시 삽입(uploading) → (b) 이미지면 압축 → (c) 업로드+register
 *     → (d) 성공 시 ref(assetId) 로 swap(loaded) / 실패 시 error 상태로 swap.
 */
export async function startAttachmentUpload(
  editor: Editor,
  file: File,
  insertPos?: number,
): Promise<void> {
  if (!resolveDocId(editor)) {
    dispatchUploadError('문서를 먼저 저장한 후 첨부할 수 있습니다.');
    return;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    dispatchFileSizeError(file);
    return;
  }

  const { view } = editor;
  const { schema } = view.state;
  const uploadId = newUploadId();
  const isImage = file.type.startsWith('image/');

  const nodeType = schema.nodes[isImage ? 'image' : 'fileAttachment'];
  if (!nodeType) return;
  const baseAttrs = isImage
    ? { src: null, uploadId, uploading: true, filename: file.name, size: file.size, mime: file.type }
    : { filename: file.name, size: file.size, mimeType: file.type, data: '', uploadId, uploading: true };

  const node = nodeType.create(baseAttrs);
  const pos = insertPos ?? view.state.selection.anchor;
  view.dispatch(view.state.tr.insert(pos, node));

  pendingFiles.set(uploadId, file);
  await performUpload(editor, file, uploadId);
}

// error 카드 "다시 시도" — 보관된 원본 File 로 재업로드.
function retryAttachmentUpload(editor: Editor, uploadId: string): void {
  const file = pendingFiles.get(uploadId);
  if (!file) return;
  updateNodeByUploadId(editor.view, uploadId, { uploading: true, uploadError: false });
  void performUpload(editor, file, uploadId);
}

function dispatchUploadError(message: string): void {
  window.dispatchEvent(new CustomEvent('docs:file-size-error', { detail: { message } }));
}

export const ImageUploadExtension = Extension.create({
  name: 'imageUpload',

  onCreate() {
    // error 카드의 "다시 시도"(노드 컴포넌트 → window 이벤트)를 이 에디터 컨텍스트로 라우팅(import 사이클 회피).
    const editor = this.editor;
    const handler = (e: Event) => {
      const uploadId = (e as CustomEvent<{ uploadId?: string }>).detail?.uploadId;
      if (uploadId) retryAttachmentUpload(editor, uploadId);
    };
    (this.storage as { _retryHandler?: (e: Event) => void })._retryHandler = handler;
    window.addEventListener('docs:attach-retry', handler);
  },

  onDestroy() {
    const handler = (this.storage as { _retryHandler?: (e: Event) => void })._retryHandler;
    if (handler) window.removeEventListener('docs:attach-retry', handler);
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handleDrop(view: EditorView, event: Event) {
            const dragEvent = event as DragEvent;
            const files = dragEvent.dataTransfer?.files;
            if (!files || files.length === 0) return false;
            const allFiles = Array.from(files);
            if (allFiles.length === 0) return false;
            dragEvent.preventDefault();

            const coords = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
            const basePos = coords?.pos ?? view.state.selection.anchor;
            allFiles.forEach((file, i) => {
              void startAttachmentUpload(editor, file, basePos + i);
            });
            return true;
          },

          handlePaste(view: EditorView, event: Event) {
            const clipboardEvent = event as ClipboardEvent;
            const items = clipboardEvent.clipboardData?.items;
            if (!items) return false;
            const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
            if (imageItems.length === 0) return false;
            clipboardEvent.preventDefault();
            const files = imageItems
              .map((item) => item.getAsFile())
              .filter((f): f is File => f !== null);
            files.forEach((file) => {
              void startAttachmentUpload(editor, file);
            });
            return true;
          },
        },
      }),
    ];
  },
});
