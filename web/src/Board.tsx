// Схема: редактор Excalidraw над файлом .excalidraw. Грузится отдельным куском, только когда нужен.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, exportToSvg, getSceneVersion, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api, type GNode } from './api';
import { useApp } from './ctx';

const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export async function boardSvg(json: string): Promise<SVGSVGElement> {
  const data = JSON.parse(json);
  return exportToSvg({
    elements: restoreElements(data.elements ?? [], null),
    appState: { exportBackground: true, viewBackgroundColor: data.appState?.viewBackgroundColor ?? '#ffffff', exportWithDarkMode: false },
    files: data.files ?? {},
    exportPadding: 16,
  });
}

export default function BoardEditor({ node, slot }: { node: GNode; slot: HTMLElement | null }) {
  const app = useApp();
  const [initial, setInitial] = useState<any>(null);
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const ex = useRef<any>(null);
  const base = useRef<number | null>(null);
  const savedScene = useRef(0);
  const busy = useRef(false);
  const inflight = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;

  useEffect(() => {
    let alive = true;
    setInitial(null);
    api.text(node.id).then(({ text, version }) => {
      if (!alive) return;
      const data = JSON.parse(text || '{}');
      const elements = restoreElements(data.elements ?? [], null);
      base.current = version;
      savedScene.current = getSceneVersion(elements);
      setDirty(false);
      setInitial({ elements, appState: { viewBackgroundColor: data.appState?.viewBackgroundColor ?? '#ffffff' }, files: data.files ?? {}, scrollToContent: true });
    }).catch((e) => app.toast(e.message));
    return () => { alive = false; };
  }, [node.id, rev]);

  // Пришла новая версия со стороны, а здесь правок нет — перечитываем.
  useEffect(() => {
    if (initial && !busy.current && !dirtyRef.current && node.head !== base.current) setRev((r) => r + 1);
  }, [node.head]);

  const scene = () => {
    const elements = ex.current.getSceneElements();
    return { elements, json: serializeAsJSON(elements, ex.current.getAppState(), ex.current.getFiles(), 'local') };
  };

  // true — схема на сервере (или правок нет). Идущее сохранение ждём, а не пропускаем.
  const save = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current.then(() => save());
    if (!ex.current) return Promise.resolve(true);
    const run = (async () => {
      busy.current = true;
      try {
        const { json } = scene();
        const savedVer = getSceneVersion(ex.current.getSceneElementsIncludingDeleted());
        const r = await api.save(node.id, json, base.current);
        if (r.conflict) app.toast('На сервере уже другая версия. Ваша сохранена рядом как конфликтная.');
        else base.current = r.version.n;
        // Конфликтная версия тоже сохранена: правки не потеряны, второй раз её не пишем.
        // Версию сцены считаем, как onChange: по всем элементам, вместе с удалёнными. Иначе после
        // любого стирания сохранённая версия никогда не совпадёт и схема навсегда «несохранённая».
        savedScene.current = savedVer;
        const still = getSceneVersion(ex.current.getSceneElementsIncludingDeleted()) !== savedScene.current; // правили, пока шло сохранение
        dirtyRef.current = still; setDirty(still);
        if (!r.conflict) app.reload().catch(() => {}); // head и «Версии · vN» сразу, не ждём события
        return true;
      } catch (e) {
        app.toast(e instanceof Error ? e.message : String(e));
        return false;
      } finally { busy.current = false; inflight.current = null; }
    })();
    inflight.current = run;
    return run;
  }, [node.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); save(); } };
    addEventListener('keydown', key, true);
    return () => { removeEventListener('keydown', key, true); if (dirtyRef.current) save(); };
  }, [save]);

  // Уход на другой узел или граф ждёт сохранения. Не вышло — спрашиваем.
  useEffect(() => app.guard(async () => {
    if (!dirtyRef.current || await save()) return true;
    return !!(await app.ask(`Не удалось сохранить «${node.title}». Уйти без сохранения?`, [], 'Уйти без сохранения'));
  }), [save]);

  // Закрытие вкладки: браузер переспросит; если уйти — схема уходит keepalive-запросом, если влезает в 64 КБ.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => { if (dirtyRef.current) e.preventDefault(); };
    const flush = () => { if (dirtyRef.current && ex.current) api.saveOnExit(node.id, scene().json, base.current); };
    addEventListener('beforeunload', ask); addEventListener('pagehide', flush);
    return () => { removeEventListener('beforeunload', ask); removeEventListener('pagehide', flush); };
  }, [node.id]);

  return (
    <div className="board">
      {slot && createPortal(<button className={dirty ? 'primary' : ''} disabled={!dirty} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>, slot)}
      {initial && (
        <Excalidraw key={rev} initialData={initial} excalidrawAPI={(a: any) => (ex.current = a)} theme={dark() ? 'dark' : 'light'} langCode="ru-RU"
          onChange={(elements: any) => setDirty(getSceneVersion(elements) !== savedScene.current)}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true } }} />
      )}
    </div>
  );
}
