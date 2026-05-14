import { redirect } from 'next/navigation';

// AC6: /memos → /chats 리다이렉트 (기존 메모 기능은 GNB 채팅 내 접근 가능)
export default function MemosPage() {
  redirect('/chats');
}
