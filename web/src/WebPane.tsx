// Внешний сайт справа — webview десктоп-оболочки. Страница держит только прямоугольник,
// сам сайт рисует оболочка поверх него. Пока открыто меню или диалог, webview прячется: он всегда сверху.
import { useEffect, useRef, useState } from 'react';
import { shell, type WebState } from './api';
import { Icon } from './ctx';

export function WebPane({ url }: { url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<WebState | null>(null);
  useEffect(() => shell!.onState(setSt), []);
  useEffect(() => {
    const el = box.current!;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        if (document.querySelector('.overlay, .menu') || !r.width || !r.height) shell!.hide();
        else shell!.show(url, { x: r.x, y: r.y, width: r.width, height: r.height });
      });
    };
    sync();
    const ro = new ResizeObserver(sync); ro.observe(el);
    const mo = new MutationObserver(sync); mo.observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', sync);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); removeEventListener('resize', sync); shell!.hide(); };
  }, [url]);
  return (
    <div className="web">
      <div className="web-bar">
        <button className="ghost" title="Назад" disabled={!st?.back} onClick={() => shell!.nav('back')}><Icon name="chev" className="flip" /></button>
        <button className="ghost" title="Вперёд" disabled={!st?.forward} onClick={() => shell!.nav('forward')}><Icon name="chev" /></button>
        <button className="ghost" title="Обновить" onClick={() => shell!.nav('reload')}>{st?.loading ? '…' : '↻'}</button>
        <button className="ghost" title="К адресу ресурса" onClick={() => shell!.nav('home')}>⌂</button>
        <span className="web-url" title={st?.url}>{st?.url || url}</span>
        <button className="ghost" title="Открыть в браузере" onClick={() => shell!.nav('external')}>↗</button>
      </div>
      <div ref={box} className="web-view" />
    </div>
  );
}
