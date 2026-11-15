// Шрифты Excalidraw раздаём сами, а не с чужого CDN: копируем их из пакета в public/ перед сборкой.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(web, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const to = path.join(web, 'public/fonts');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
