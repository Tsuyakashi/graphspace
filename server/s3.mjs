// Минимальный клиент S3 (SILO/MinIO): PUT, GET, HEAD объекта и создание бакета.
// Подпись AWS SigV4 своими силами, path-style адреса. Без SDK: нужно четыре запроса.
import { createHash, createHmac } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { secret } from './env.mjs';

const ENDPOINT = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
const BUCKET = process.env.S3_BUCKET || 'graphspace';
const REGION = process.env.S3_REGION || 'us-east-1';
const ACCESS = process.env.S3_ACCESS_KEY || '';
const SECRET = secret('S3_SECRET_KEY') || '';
const EMPTY = createHash('sha256').update('').digest('hex');

export function checkS3Config() {
  if (!ENDPOINT || !ACCESS || !SECRET) throw new Error('нужны S3_ENDPOINT, S3_ACCESS_KEY и S3_SECRET_KEY (или S3_SECRET_KEY_FILE)');
  return `${ENDPOINT}/${BUCKET}`;
}

const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
// RFC 3986, как требует SigV4: кодируется всё, кроме A-Z a-z 0-9 - _ . ~ (и / в пути).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (s) => s.split('/').map(enc).join('/');

// Заголовки подписи для запроса. Экспортируется ради теста на эталонном примере AWS.
export function sign({ method, host, path, headers = {}, payloadHash = EMPTY, date = new Date(), access = ACCESS, secretKey = SECRET, region = REGION }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonical = [method, path, '', names.map((k) => `${k}:${all[k]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

async function request(method, key, { body, payloadHash = EMPTY, headers = {} } = {}) {
  const url = new URL(ENDPOINT);
  const path = `${url.pathname.replace(/\/+$/, '')}/${enc(BUCKET)}${key ? '/' + encPath(key) : ''}`;
  const signed = sign({ method, host: url.host, path, headers, payloadHash });
  delete signed.host; // fetch выставит сам
  return fetch(`${url.origin}${path}`, { method, headers: signed, body, signal: AbortSignal.timeout(60_000) });
}

const failed = async (what, res) => new Error(`S3 ${what}: ${res.status} ${(await res.text()).slice(0, 200)}`);

export async function ensureBucket() {
  const res = await request('PUT', '');
  // 409 BucketAlreadyOwnedByYou — бакет уже есть.
  if (!res.ok && res.status !== 409) throw await failed('бакет', res);
}

// hash — sha256 содержимого, он же ключ: подпись использует его как хэш тела.
export async function put(key, bytes, hash) {
  const res = await request('PUT', key, { body: bytes, payloadHash: hash, headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length } });
  if (!res.ok) throw await failed('запись', res);
}

export async function exists(key) {
  const res = await request('HEAD', key);
  if (res.status === 404) return false;
  if (!res.ok) throw await failed('проверка', res);
  return true;
}

export async function get(key) {
  const res = await request('GET', key);
  if (res.status === 404) throw new HttpError(404, 'содержимое потеряно');
  if (!res.ok) throw await failed('чтение', res);
  return Buffer.from(await res.arrayBuffer());
}
