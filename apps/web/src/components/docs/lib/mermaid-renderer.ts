let initPromise: Promise<void> | null = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          background: '#0b1120',
          primaryColor: '#1e3a5f',
          primaryTextColor: '#e2e8f0',
          lineColor: '#475569',
          edgeLabelBackground: '#1e293b',
          clusterBkg: '#1e293b',
          titleColor: '#e2e8f0',
        },
        securityLevel: 'loose',
      });
    })();
  }
  return initPromise;
}

let counter = 0;

export async function renderMermaid(code: string): Promise<{ svg: string }> {
  await ensureInit();
  const { default: mermaid } = await import('mermaid');
  const id = `mermaid-${++counter}-${Date.now()}`;
  const { svg } = await mermaid.render(id, code.trim());
  return { svg };
}
