// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { FileAttachmentNode } from './file-node';
import { CustomImageNode } from './image-node';
import { ImageUploadExtension, registerDocIdProvider, startAttachmentUpload } from './image-upload';

// S4 끝단 적출(dev 픽셀): 파일 첨부가 upload200+register200(asset_id 반환)인데도 노드가
// data-asset-id 없이(data-file-data="") 직렬화 → read-only/reload 서 inert·라운드트립 유실.
// 근본: file-node 의 assetId attr 에 attr-level renderHTML 이 있어 HTMLAttributes.assetId 가
// data-asset-id 로 미리 매핑됨 → 노드 renderHTML 의 assetId=undefined → 항상 data-file-data.
// 이 테스트가 "노드 assetId → getHTML data-asset-id" 계약을 잠근다(이미지 control 포함).
beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/attachments')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://gcs/doc/f.bin', name: 'f.bin', content_type: 'application/octet-stream', size: 12 }) } as Response;
    }
    if (u.includes('/assets')) {
      // BE 실 응답 형상 — snake `data.asset_id`.
      return { ok: true, status: 200, json: async () => ({ data: { asset_id: 'AID-1', filename: 'f.bin', size: 12, mime: 'application/octet-stream' }, error: null, meta: null }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

function makeEditor() {
  return new Editor({
    extensions: [Document, Paragraph, Text, CustomImageNode, FileAttachmentNode, ImageUploadExtension],
    content: '<p></p>',
  });
}

async function flush() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('attachment upload → asset-ref 직렬화 라운드트립 (S4)', () => {
  it('파일 업로드: 노드 assetId 설정 + getHTML 이 data-asset-id 직렬화(data-file-data 아님)', async () => {
    const editor = makeEditor();
    registerDocIdProvider(editor, () => 'DOC-1');
    await startAttachmentUpload(editor, new File(['hello world!'], 'f.bin', { type: 'application/octet-stream' }));
    await flush();

    const html = editor.getHTML();
    expect(html).toContain('data-type="fileAttachment"');
    expect(html).toContain('data-asset-id="AID-1"');
    expect(html).not.toContain('data-file-data'); // ref 면 legacy attr 부재(상호배타).
    editor.destroy();
  });

  it('이미지 업로드(control): getHTML 이 data-asset-id 직렬화(src 부재)', async () => {
    const editor = makeEditor();
    registerDocIdProvider(editor, () => 'DOC-1');
    // 1x1 PNG (압축 분기 회피 위해 <1MB)
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    await startAttachmentUpload(editor, new File([png], 'a.png', { type: 'image/png' }));
    await flush();

    const html = editor.getHTML();
    expect(html).toContain('data-asset-id="AID-1"');
    expect(html).not.toMatch(/<img[^>]*\ssrc=/); // ref 이미지는 src 미직렬화.
    editor.destroy();
  });
});
