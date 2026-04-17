import { MockupEditorShell } from '@/components/mockups/mockup-editor-shell';

interface MockupEditorPageProps {
  params: {
    id: string;
  };
}

export default function MockupEditorPage({ params }: MockupEditorPageProps) {
  return <MockupEditorShell mockupId={params.id} />;
}
