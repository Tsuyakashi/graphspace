// Текстовый док: markdown плюс вставки ![[id]] и виды ![[id|type=doc]]. Вставленное не копируется, а читается из узла.
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, type GNode } from './api';
import { NodeIcon, openNode, useApp } from './ctx';
import { matches, parseFilter, pathOf, scopeOf, TYPE_LABEL } from './model';

const EMBED_LINE = /^\s*!\[\[([a-z0-9]{6,})(?:@([^\]|]*))?(?:\|([^\]]*))?\]\]\s*$/;
const MENTION = /!?\[\[([a-z0-9]{6,})(?:@[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MAX_DEPTH = 3;

type Part = { md: string } | { id: string; pin?: string; opts: Record<string, string> };

function split(text: string): Part[] {
  const parts: Part[] = [];
  let buf: string[] = [], fence = false;
  const flush = () => { if (buf.join('').trim()) parts.push({ md: buf.join('\n') }); buf = []; };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(EMBED_LINE);
    if (!m) { buf.push(line); continue; }
    flush();
    const opts = Object.fromEntries((m[3] ?? '').split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2));
    parts.push({ id: m[1], pin: m[2]?.trim() || undefined, opts });
  }
  flush();
  return parts;
}

// Текст узла в конкретной версии. Ключ включает номер версии, поэтому вставки обновляются вживую.
const textCache = new Map<string, Promise<string>>();
export function useText(node: GNode | undefined, version?: number | null): string | null {
  const v = version ?? node?.head ?? null;
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!node || !v) { setText(node ? '' : null); return; }
    const key = `${node.id}@${v}`;
    let p = textCache.get(key);
    if (!p) { p = api.text(node.id, v).then((r) => r.text); textCache.set(key, p); }
    let alive = true;
    p.then((t) => alive && setText(t)).catch(() => alive && setText(''));
    return () => { alive = false; };
  }, [node?.id, v]);
  return text;
}

export function Markdown({ text, depth = 0, chain = [] }: { text: string; depth?: number; chain?: string[] }) {
  const app = useApp();
  const parts = useMemo(() => split(text), [text]);
  const html = (md: string) => {
    const linked = md.replace(MENTION, (_, id) => {
      const n = app.ix.byId.get(id);
      return n ? `[${n.title.replace(/([\[\]])/g, '\\$1')}](#/n/${id})` : '`узел не найден`';
    });
    return DOMPurify.sanitize(marked.parse(linked, { async: false, gfm: true }) as string);
  };
  const click = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (href.startsWith('#/n/')) openNode(app, href.slice(4));
    else window.open(href, '_blank', 'noopener');
  };
  return (
    <div className="md" onClick={click}>
      {parts.map((p, i) => ('md' in p
        ? <div key={i} dangerouslySetInnerHTML={{ __html: html(p.md) }} />
        : <Embed key={i} id={p.id} pin={p.pin} opts={p.opts} depth={depth} chain={chain} />))}
    </div>
  );
}

function Frame({ node, note, children }: { node: GNode; note?: string; children?: React.ReactNode }) {
  const app = useApp();
  return (
    <section className="embed">
      <header>
        <NodeIcon node={node} />
        <a href={`#/n/${node.id}`}>{node.title}</a>
        <span className="muted">{note ?? pathOf(app.ix, node.id).slice(0, -1).map((p) => p.title).join(' / ')}</span>
      </header>
      {children}
    </section>
  );
}

function Embed({ id, pin, opts, depth, chain }: { id: string; pin?: string; opts: Record<string, string>; depth: number; chain: string[] }) {
  const app = useApp();
  const node = app.ix.byId.get(id);
  if (!node) return <div className="embed missing">Вставка: узел {id} не найден или в корзине</div>;
  if (chain.includes(id)) return <div className="embed missing">Вставка «{node.title}» ссылается сама на себя</div>;
  if (depth >= MAX_DEPTH) return <Frame node={node} note="глубже вставки не раскрываются" />;

  if (opts.type || node.type === 'space') return <ViewEmbed node={node} filter={parseFilter(opts.type ?? '')} depth={depth} chain={[...chain, id]} />;
  if (node.type === 'doc') return <DocEmbed node={node} pin={pin} depth={depth} chain={[...chain, id]} />;
  if (node.type === 'board') return <Frame node={node}><BoardImage node={node} /></Frame>;
  if (node.type === 'resource') return <ResourceLine node={node} />;
  if (node.type === 'file' && /^(png|jpe?g|gif|webp|svg)$/.test(node.ext ?? '') && node.head) {
    return <Frame node={node}><img className="embed-img" src={api.contentUrl(node.id, node.head)} alt={node.title} /></Frame>;
  }
  if (app.config.preview && ['docx', 'odt', 'rtf'].includes(node.ext ?? '') && node.head) {
    return <Frame node={node} note="первая страница"><a href={`#/n/${node.id}`}><img className="embed-page" src={`/api/nodes/${node.id}/preview?v=${node.head}`} alt={`Первая страница: ${node.title}`} /></a></Frame>;
  }
  return <Frame node={node} note={`${TYPE_LABEL[node.type]}${node.ext ? ` · ${node.ext}` : ''}`} />;
}

// Вставка-вид: всё подходящее из области узла. Доки раскрываются текстом, остальное — строками.
function ViewEmbed({ node, filter, depth, chain }: { node: GNode; filter: string; depth: number; chain: string[] }) {
  const app = useApp();
  const items = scopeOf(app.ix, node.id).filter((s) => (filter ? matches(s.node, filter) : s.node.type !== 'space'));
  if (!items.length) return <div className="embed missing">В «{node.title}» пока нет подходящих узлов</div>;
  return (
    <div className="embed-view">
      {items.map(({ node: n, via }) => (n.type === 'doc'
        ? <DocEmbed key={n.id} node={n} depth={depth} chain={chain} from={node.id} />
        : n.type === 'resource'
          ? <ResourceLine key={n.id} node={n} from={node.id} shared={!!via} />
          : <Frame key={n.id} node={n} note={pathOf(app.ix, n.id, node.id).slice(0, -1).map((p) => p.title).join(' / ') || TYPE_LABEL[n.type]} />))}
    </div>
  );
}

function DocEmbed({ node, pin, depth, chain, from }: { node: GNode; pin?: string; depth: number; chain: string[]; from?: string }) {
  const app = useApp();
  const [pinned, setPinned] = useState<number | null | undefined>(pin ? undefined : null);
  useEffect(() => {
    if (!pin) return;
    if (/^\d+$/.test(pin)) { setPinned(Number(pin)); return; }
    api.versions(node.id).then((vs) => setPinned(vs.find((v) => v.name === pin)?.n ?? -1)).catch(() => setPinned(-1));
  }, [node.id, pin]);
  const text = useText(pinned === undefined || pinned === -1 ? undefined : node, pinned);
  const where = pathOf(app.ix, node.id, from ?? null).slice(0, -1).map((p) => p.title).join(' / ');
  if (pinned === -1) return <div className="embed missing">У «{node.title}» нет снапшота «{pin}»</div>;
  return (
    <Frame node={node} note={pin ? `${where} · снапшот «${pin}»` : where}>
      {text === null ? <div className="muted pad">Загрузка…</div> : <Markdown text={text} depth={depth + 1} chain={chain} />}
    </Frame>
  );
}

function ResourceLine({ node, from, shared }: { node: GNode; from?: string; shared?: boolean }) {
  const app = useApp();
  const where = pathOf(app.ix, node.id, from ?? null).slice(0, -1).map((p) => p.title).join(' / ');
  return (
    <div className="embed res-line">
      <NodeIcon node={node} />
      <a href={`#/n/${node.id}`}>{node.title}</a>
      <span className="label">{node.props.kind}</span>
      {node.props.url && <a className="url" href={node.props.url}>{node.props.url}</a>}
      <span className="muted">{where}{shared ? ' · общий' : ''}</span>
    </div>
  );
}

function BoardImage({ node }: { node: GNode }) {
  const text = useText(node);
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!text) return;
    let alive = true;
    import('./Board').then((m) => m.boardSvg(text)).then((svg) => {
      if (!alive || !ref.current) return;
      svg.removeAttribute('width'); svg.removeAttribute('height');
      ref.current.replaceChildren(svg);
    }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [text]);
  if (failed) return <div className="muted pad">Не удалось показать схему</div>;
  return <div ref={ref} className="embed-board"><span className="muted pad">Схема загружается…</span></div>;
}
