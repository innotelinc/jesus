export interface ExportRequestOptions {
  url?: string;
  method?: 'POST' | 'GET';
  body?: unknown;
  filename?: string;
}

export async function exportJSON(
  data: unknown,
  options: ExportRequestOptions & { filename: string }
): Promise<void> {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = options.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportPDFViaServer(
  request: ExportRequestOptions & { filename: string }
): Promise<void> {
  const targetUrl = request.url ?? '/api/export/ports/pdf';

  const response = await fetch(targetUrl, {
    method: request.method ?? 'POST',
    headers: {
      Accept: 'application/pdf',
      'Content-Type': request.body ? 'application/json' : 'text/plain',
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Export request failed: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const isPdf = contentType.includes('application/pdf');

  if (isPdf) {
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = request.filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  const text = await response.text();
  const fallbackBlob = new Blob([text], { type: 'text/html' });
  const fallbackUrl = URL.createObjectURL(fallbackBlob);
  const fallbackWindow = window.open(fallbackUrl, '_blank');

  if (!fallbackWindow) {
    URL.revokeObjectURL(fallbackUrl);
    throw new Error('PDF export requires a printable browser window.');
  }

  fallbackWindow.document.write(text);
  fallbackWindow.document.close();
  fallbackWindow.focus();
  fallbackWindow.print();
}
