// Офисные файлы, PDF и макеты: веб-сборка Craft в iframe на том же origin, обмен по postMessage.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type GNode } from './api';
import { useApp } from './ctx';
import { fileName, splitName, typeForExt } from './model';

export function CraftView({ node, slot }: { node: GNode; slot: HTMLElement | null }) {
  const app = useApp();
  const craft = app.config.craftByExt[node.ext ?? ''];
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef<any>(null);
  const base = useRef<number | null>(null);
  const busy = useRef(false);
  const [status, setStatus] = useState('Редактор загружается…');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const nodeRef = useRef(node); nodeRef.current = node;
  const waiter = useRef<((ok: boolean) => void) | null>(null); // ждёт save из редактора при уходе с узла

  // Сохранить из хоста: та же команда, что Ctrl+S внутри. Ответ — сообщение save, а за ним запись версии.
  const saveNow = () => new Promise<boolean>((resolve) => {
    const ctl = (frame.current?.contentWindow as any)?.[craft];
    if (typeof ctl?.execute !== 'function') return resolve(false);
    let timer = 0;
    const finish = (ok: boolean) => { clearTimeout(timer); if (waiter.current === finish) waiter.current = null; resolve(ok); };
    timer = window.setTimeout(() => finish(false), 20000);
    waiter.current = finish;
    Promise.resolve().then(() => ctl.execute('file.save', {})).catch(() => finish(false));
  });

  const sendOpen = async () => {
    const n = nodeRef.current;
    if (!ready.current || !frame.current?.contentWindow) return;
    // Содержимое берём с сервера, а не по head из состояния: оно могло не успеть обновиться
    // (сохранили при уходе — вернулись раньше, чем пришло событие), и узел открылся бы пустым.
    const c = await api.content(n.id).catch(() => null);
    let bytes: ArrayBuffer;
    if (c) {
      bytes = c.bytes; base.current = c.version;
    } else {
      // Пустой узел: открываем пустой шаблон под именем узла. Безымянный документ Craft сохранил бы
      // в свой формат (Presentation1.deckcraft) отдельным файлом, а с именем Save пишет в .pptx сюда.
      const t = n.ext ? await fetch(`/blank/blank.${n.ext}`) : null;
      if (!t?.ok) return;
      bytes = await t.arrayBuffer(); base.current = null;
    }
    const name = fileName(n);
    // ready.file === true — приложение принимает File, иначе байты.
    const msg = ready.current.file ? { type: `${craft}:open`, name, file: new File([bytes], name) } : { type: `${craft}:open`, name, bytes };
    frame.current.contentWindow.postMessage(msg, location.origin, ready.current.file ? [] : [bytes]);
  };

  useEffect(() => {
    if (!craft) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data ?? {};
      if (typeof d.type !== 'string' || !d.type.startsWith(craft + ':')) return;
      const kind = d.type.slice(craft.length + 1);
      if (kind === 'ready') {
        ready.current = d;
        setStatus(`${craft} ${d.appVersion ?? ''}`.trim());
        sendOpen().catch((err) => app.toast(err.message));
      } else if (kind === 'dirty') {
        setDirty(!!d.dirty);
      } else if (kind === 'failed') {
        setStatus(`Редактор не запустился: ${d.error}`);
      } else if (kind === 'save') {
        app.run(async () => {
          const n = nodeRef.current;
          const { base: title, ext } = splitName(String(d.name ?? ''));
          // Ответ на save с id: файл принят, редактор снимает «есть правки».
          const ack = () => { if (d.id != null) frame.current?.contentWindow?.postMessage({ type: `${craft}:saved`, id: d.id }, location.origin); };
          // export: true (GridCraft) — копия в другом формате, даже если расширение совпало.
          if (d.export !== true && (!ext || ext.toLowerCase() === n.ext)) {
            busy.current = true;
            try {
              const r = await api.save(n.id, d.bytes, base.current);
              if (r.conflict) app.toast('На сервере уже другая версия. Ваша сохранена рядом как конфликтная.');
              else { base.current = r.version.n; if (!r.unchanged) app.toast(`Сохранена версия v${r.version.n}`); }
              dirtyRef.current = false; setDirty(false); // конфликтная тоже сохранена
              ack();
              waiter.current?.(true);
              if (!r.unchanged) app.reload().catch(() => {}); // не ждём события: head нужен сразу
            } catch (err) { waiter.current?.(false); throw err; } finally { busy.current = false; }
          } else {
            // Экспорт в другой формат не подменяет файл, а ложится рядом отдельным узлом.
            const t = typeForExt(ext);
            const made = await api.create({ type: t.type, title: t.type === 'file' ? d.name : title, parent_id: n.parent_id, ext: t.ext });
            await api.save(made.id, d.bytes, null);
            ack();
            waiter.current?.(true); // правки целы — в соседнем узле
            await app.reload();
            app.toast(`Экспорт сохранён рядом: ${d.name}`, { label: 'Открыть', run: () => app.go({ sel: made.id }) });
          }
        });
      }
    };
    addEventListener('message', onMessage);
    const leave = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    addEventListener('beforeunload', leave);
    return () => { removeEventListener('message', onMessage); removeEventListener('beforeunload', leave); };
  }, [craft, node.id]);

  // Уход на другой узел или граф уничтожает iframe вместе с правками: сначала сохраняем.
  useEffect(() => app.guard(async () => {
    if (!dirtyRef.current) return true;
    app.toast(`Сохраняю «${nodeRef.current.title}»…`);
    if (await saveNow()) return true;
    return !!(await app.ask(`«${nodeRef.current.title}» не сохранился автоматически. Останьтесь и сохраните Ctrl+S в редакторе или уйдите без сохранения.`, [], 'Уйти без сохранения'));
  }), [craft, node.id]);

  // Новая версия пришла со стороны (например, из нативного приложения) — перечитываем, если здесь нет правок.
  useEffect(() => {
    if (ready.current && !busy.current && !dirtyRef.current && node.head !== base.current) sendOpen().catch(() => {});
  }, [node.head]);

  if (!craft || !app.config.web[craft]) {
    return (
      <div className="pane-note">
        <p>Веб-сборки редактора для .{node.ext} на сервере нет.</p>
        <p className="muted">Файл можно скачать или открыть нативно, если приложение установлено.</p>
      </div>
    );
  }
  return (
    <div className="craft">
      {slot && createPortal(
        <span className={`state ${dirty ? 'dirty' : ''}`} title="Сохранение — Ctrl+S внутри редактора">
          {dirty ? 'Есть несохранённые правки' : status}{!node.head && !dirty ? ' · новый файл, первая версия появится при сохранении' : ''}
        </span>, slot)}
      <iframe ref={frame} key={node.id} title={`${craft}: ${node.title}`} allow="fullscreen; clipboard-read; clipboard-write"
        src={`/craft/${craft}/?host=parent&author=${encodeURIComponent(app.config.author)}`} />
    </div>
  );
}
