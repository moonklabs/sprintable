import { MockupEditorShell } from '@/components/mockups/mockup-editor-shell';

interface MockupEditorPageProps {
  params: Promise<{
    ws: string;
    proj: string;
    id: string;
  }>;
}

export default async function MockupEditorPage({ params }: MockupEditorPageProps) {
  const { ws, proj, id } = await params;
  return <MockupEditorShell mockupId={id} wsSlug={ws} projSlug={proj} />;
}
