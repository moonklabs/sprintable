'use client';

export function OssPersonaFormClient({ agents }: { agents: Array<{ id: string; name: string }> }) {
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const res = await fetch('/api/agents/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            agent_id: fd.get('agent_id'),
            system_prompt: fd.get('system_prompt'),
            description: fd.get('description'),
          }),
        });
        if (res.ok) window.location.href = '/agents';
      }}
    >
      <div className="space-y-2">
        <label className="text-sm font-medium">Agent</label>
        <select name="agent_id" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Persona Name</label>
        <input name="name" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="e.g. Helpful Assistant" required />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">System Prompt</label>
        <textarea name="system_prompt" rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="You are a helpful assistant..." />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Description (optional)</label>
        <input name="description" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="Brief description" />
      </div>
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        Create Persona
      </button>
    </form>
  );
}
