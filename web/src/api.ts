export type NodeType = 'space' | 'doc' | 'board' | 'office' | 'pdf' | 'design' | 'file' | 'resource';

export interface GNode {
  id: string;
  type: NodeType;
  title: string;
  parent_id: string | null;
  position: number;
  props: Record<string, any>;
  ext: string | null;
  head: number | null;
  owner: string; // владелец пространства, в котором живёт узел
  created_at: string;
  updated_at: string;
}
export interface Link { from_id: string; to_id: string; kind: 'uses' | 'embeds' | 'mentions' }
export interface Share { node_id: string; email: string }
// sharing — кому открыты мои узлы; users — все, кто хоть раз входил.
export interface State { me: string; nodes: GNode[]; links: Link[]; checkouts: string[]; users: string[]; sharing: Share[] }
export interface Version { node_id: string; n: number; blob: string; size: number; author: string; created_at: string; name: string | null }
export interface Config {
  author: string;
  craftByExt: Record<string, string>;
  web: Record<string, boolean>;
  native: Record<string, boolean>;
  preview: boolean;
  auth: 'dev' | 'cf';
}
export interface SaveResult { version: Version; conflict?: boolean; unchanged?: boolean }

async function j<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ошибка ${res.status}`);
  return data as T;
}

export const api = {
  state: () => j<State>('GET', '/api/state'),
  config: () => j<Config>('GET', '/api/config'),
  create: (n: Partial<GNode>) => j<GNode>('POST', '/api/nodes', n),
  patch: (id: string, p: Partial<GNode>) => j<GNode>('PATCH', `/api/nodes/${id}`, p),
  trash: (id: string) => j('DELETE', `/api/nodes/${id}`),
  restore: (id: string) => j('POST', `/api/nodes/${id}/restore`),
  link: (from: string, to: string) => j('POST', '/api/links', { from, to, kind: 'uses' }),
  unlink: (from: string, to: string) => j('DELETE', '/api/links', { from, to, kind: 'uses' }),
  versions: (id: string) => j<Version[]>('GET', `/api/nodes/${id}/versions`),
  nameVersion: (id: string, n: number, name: string) => j<Version>('PATCH', `/api/nodes/${id}/versions/${n}`, { name }),
  restoreVersion: (id: string, n: number) => j<SaveResult>('POST', `/api/nodes/${id}/versions/${n}/restore`),
  share: (id: string, email: string) => j('POST', `/api/nodes/${id}/shares`, { email }),
  unshare: (id: string, email: string) => j('DELETE', `/api/nodes/${id}/shares/${encodeURIComponent(email)}`),
  openNative: (id: string) => j<{ file: string; already?: boolean }>('POST', `/api/nodes/${id}/open-native`),

  contentUrl: (id: string, v?: number | null, download = false) =>
    `/api/nodes/${id}/content?${v ? `v=${v}&` : ''}${download ? 'download' : ''}`,

  exportUrl: (id: string) => `/api/nodes/${id}/export`,

  async content(id: string, v?: number | null): Promise<{ bytes: ArrayBuffer; version: number }> {
    const res = await fetch(api.contentUrl(id, v));
    if (!res.ok) throw new Error('содержимого нет');
    return { bytes: await res.arrayBuffer(), version: Number(res.headers.get('x-version')) };
  },
  async text(id: string, v?: number | null): Promise<{ text: string; version: number }> {
    const { bytes, version } = await api.content(id, v);
    return { text: new TextDecoder().decode(bytes), version };
  },
  // Сохранение всегда создаёт новую версию. base — версия, поверх которой правили: если на сервере уже
  // другая, байты лягут рядом конфликтной версией, а текущая не изменится.
  async save(id: string, body: BodyInit, base: number | null): Promise<SaveResult> {
    const res = await fetch(`/api/nodes/${id}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-base-version': base == null ? '' : String(base) },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(data.error || `ошибка ${res.status}`);
    return data as SaveResult;
  },
  // Сохранение при закрытии вкладки: keepalive переживает страницу, но тело — до 64 КБ. Ответ не ждём.
  saveOnExit(id: string, body: string, base: number | null) {
    try {
      fetch(`/api/nodes/${id}/content`, {
        method: 'PUT', keepalive: true, body,
        headers: { 'content-type': 'application/octet-stream', 'x-base-version': base == null ? '' : String(base) },
      }).catch(() => {});
    } catch { /* больше 64 КБ — keepalive не принимает, остаётся вопрос браузера */ }
  },
};

// Десктоп-оболочка (desktop/): webview поверх прямоугольника панели. В обычном браузере её нет.
export interface WebState { url: string; title: string; loading: boolean; back: boolean; forward: boolean }
export interface Shell {
  show(url: string, rect: { x: number; y: number; width: number; height: number }): void;
  hide(): void;
  nav(action: 'back' | 'forward' | 'reload' | 'home' | 'external'): void;
  onState(cb: (s: WebState) => void): () => void;
}
export const shell: Shell | undefined = (window as any).graphspaceShell;
