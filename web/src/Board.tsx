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

  const save = useCallback(async () => {
    if (!ex.current || busy.current) return;
    busy.current = true;
    try {
      const elements = ex.current.getSceneElements();
      const r = await api.save(node.id, serializeAsJSON(elements, ex.current.getAppState(), ex.current.getFiles(), 'local'), base.current);
      if (r.conflict) app.toast('На сервере уже другая версия. Ваша сохранена рядом как конфликтная.');
      else { base.current = r.version.n; savedScene.current = getSceneVersion(elements); setDirty(false); }
    } catch (e) { app.toast(e instanceof Error ? e.message : String(e)); } finally { busy.current = false; }
  }, [node.id]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
    addEventListener('keydown', key, true);
    return () => { removeEventListener('keydown', key, true); if (dirtyRef.current) save(); };
  }, [save]);

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
