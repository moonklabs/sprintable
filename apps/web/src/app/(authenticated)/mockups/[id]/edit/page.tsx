import { MockupEditorShell } from '@/components/mockups/mockup-editor-shell';

interface MockupEditorPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default async function MockupEditorPage({ params }: MockupEditorPageProps) {
  const { id } = await params;
  return <MockupEditorShell mockupId={id} />;
}
