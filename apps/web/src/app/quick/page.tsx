import { QuickAsk } from './quick-ask';

// story 5047 (C14 · PO 11-27): the page the Mac app's quick-ask window (⌥Space) shows — and nothing else. A static shell with no data (proxy.ts lists it as public for that reason: the window must never be
// redirected to /login, which is not a page it may show); the page reads who the person is through the same API calls the rest of the web makes, and says «로그인이 필요해요» itself.
export default function QuickPage() {
  return <QuickAsk />;
}
