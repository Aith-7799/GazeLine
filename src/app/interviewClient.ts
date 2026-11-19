export class InterviewApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function interviewRequest<T>(path: string, token?: string, body?: unknown, keepalive = false, method?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), 12000);
  try {
    const apiRoot = path.startsWith('/auth') ? '/api' : '/api/interviews';
    const response = await fetch(apiRoot + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), headers,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', keepalive, signal: abort.signal,
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    const data = await response.json();
    if (!response.ok) throw new InterviewApiError(response.status, data.error || 'The interview request failed.');
    return data as T;
  } catch (error) {
    if (error instanceof InterviewApiError) throw error;
    throw new InterviewApiError(0, 'Could not reach the interview server. Check the connection and retry.');
  } finally { clearTimeout(timer); }
}

export const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const errorText = (error: unknown) => error instanceof Error ? error.message : 'The interview request failed.';

