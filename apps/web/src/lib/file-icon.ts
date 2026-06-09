import { File, FileCode, FileText, Image as ImageIcon, type LucideIcon } from 'lucide-react';

// chat-attach: content_type → 표시 아이콘 매핑 (chat-input pending 칩 / chat-bubble 파일 칩 공용).
// image → ImageIcon / pdf·text·csv·md → FileText / code → FileCode / 기타 → File
export function getFileIcon(contentType?: string | null): LucideIcon {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return ImageIcon;
  if (ct === 'application/pdf' || ct.startsWith('text/')) return FileText;
  if (
    ct.includes('javascript') ||
    ct.includes('typescript') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('html')
  ) {
    return FileCode;
  }
  return File;
}
