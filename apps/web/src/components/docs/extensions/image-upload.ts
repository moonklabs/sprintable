import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { MAX_FILE_BYTES, fileToDataUrl, formatFileSize } from './file-node';

const MAX_IMAGE_BYTES = 1 * 1024 * 1024; // 1 MB — images are compressed above this
const MAX_DIM = 1920;

function dispatchFileSizeError(file: File): void {
  window.dispatchEvent(new CustomEvent('docs:file-size-error', {
    detail: { message: `파일 크기가 5MB를 초과합니다. (${formatFileSize(file.size)})` },
  }));
}

function insertFileAttachment(view: EditorView, file: File, dataUrl: string, pos?: number): void {
  const { schema, selection } = view.state;
  const nodeType = schema.nodes['fileAttachment'];
  if (!nodeType) return;
  const node = nodeType.create({
    filename: file.name,
    size: file.size,
    mimeType: file.type,
    data: dataUrl,
  });
  const insertPos = pos ?? selection.anchor;
  view.dispatch(view.state.tr.insert(insertPos, node));
}

async function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader 오류'));
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (file.size <= MAX_IMAGE_BYTES) {
        resolve(dataUrl);
        return;
      }
      // Compress via canvas
      const img = new Image();
      img.onerror = () => reject(new Error('이미지 로드 오류'));
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
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, w, h);

        let quality = 0.85;
        let compressed = canvas.toDataURL('image/jpeg', quality);
        while (compressed.length * 0.75 > MAX_IMAGE_BYTES && quality > 0.3) {
          quality = Math.max(0.3, quality - 0.1);
          compressed = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(compressed);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function insertImageSrc(view: EditorView, src: string, pos?: number): void {
  const { schema, selection } = view.state;
  const imageType = schema.nodes['image'];
  if (!imageType) return;
  const node = imageType.create({ src });
  const insertPos = pos ?? selection.anchor;
  const tr = view.state.tr.insert(insertPos, node);
  view.dispatch(tr);
}

export const ImageUploadExtension = Extension.create({
  name: 'imageUpload',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('imageUpload'),
        props: {
          handleDrop(view: EditorView, event: Event) {
            const dragEvent = event as DragEvent;
            const files = dragEvent.dataTransfer?.files;
            if (!files || files.length === 0) return false;

            const allFiles = Array.from(files);
            const images = allFiles.filter((f) => f.type.startsWith('image/'));
            const nonImages = allFiles.filter((f) => !f.type.startsWith('image/'));

            if (images.length === 0 && nonImages.length === 0) return false;
            dragEvent.preventDefault();

            const coords = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY });
            const basePos = coords?.pos ?? view.state.selection.anchor;

            void Promise.all(images.map(processImageFile)).then((srcs) => {
              srcs.forEach((src, i) => insertImageSrc(view, src, basePos + i));
            });

            nonImages.forEach((file) => {
              if (file.size > MAX_FILE_BYTES) { dispatchFileSizeError(file); return; }
              void fileToDataUrl(file).then((dataUrl) => insertFileAttachment(view, file, dataUrl, basePos));
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
            const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);

            void Promise.all(files.map(processImageFile)).then((srcs) => {
              srcs.forEach((src) => insertImageSrc(view, src));
            });

            return true;
          },
        },
      }),
    ];
  },
});
