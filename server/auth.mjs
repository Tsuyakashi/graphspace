// Кто пришёл. Наружу Graphspace публикуется только через Cloudflare Tunnel + Access:
// пользователь — из JWT в заголовке Cf-Access-Jwt-Assertion, подпись проверяется по JWKS команды.
// Заголовку с почтой без проверки JWT не доверяем. AUTH_MODE=dev — пользователь для разработки:
// AUTH_DEV_USER или заголовок x-graphspace-dev-user (тесты доступа). Вне dev этот заголовок игнорируется.
import crypto from 'node:crypto';
import { HttpError } from './errors.mjs';

export const AUTH_MODE = process.env.AUTH_MODE === 'dev' ? 'dev' : 'cf';
export const DEV_USER = process.env.AUTH_DEV_USER || 'dev@localhost';
// https://<team>.cloudflareaccess.com — это же значение iss в токене.
const TEAM = (process.env.CF_ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
const AUD = process.env.CF_ACCESS_AUD || '';
const CERTS = `${TEAM}/cdn-cgi/access/certs`;
const SKEW = 60; // секунд допуска на расхождение часов

export function checkAuthConfig() {
  if (AUTH_MODE === 'dev') return 'dev: все запросы от ' + DEV_USER;
  if (!TEAM || !AUD) throw new Error('нужны CF_ACCESS_TEAM_DOMAIN и CF_ACCESS_AUD (или AUTH_MODE=dev для разработки)');
  return `Cloudflare Access: ${TEAM}`;
}

// Ключи команды по kid. Неизвестный kid — повод перечитать JWKS (ротация), но не чаще раза в минуту.
let keys = new Map();
let fetchedAt = 0;
let inflight = null;
async function keyFor(kid) {
  if (keys.has(kid)) return keys.get(kid);
  if (Date.now() - fetchedAt > 60_000) {
    inflight ??= (async () => {
      try {
        const res = await fetch(CERTS, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`JWKS: ${res.status}`);
        const { keys: list = [] } = await res.json();
        keys = new Map(list.filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
        fetchedAt = Date.now();
      } catch (e) {
        console.error('Cloudflare Access: не удалось получить ключи', e.message);
      } finally { inflight = null; }
    })();
    await inflight;
  }
  return keys.get(kid);
}

const deny = () => new HttpError(401, 'нужен вход через Cloudflare Access');
const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function userOf(req) {
  if (AUTH_MODE === 'dev') {
    const h = req.headers['x-graphspace-dev-user'];
    return (typeof h === 'string' && h.trim() ? h : DEV_USER).trim().toLowerCase();
  }
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string') throw deny();
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw deny();
  let header, claims;
  try { header = part(h); claims = part(p); } catch { throw deny(); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw deny();
  const key = await keyFor(header.kid);
  if (!key || !crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) throw deny();
  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== TEAM || !aud.includes(AUD)) throw deny();
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW) throw deny();
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW) throw deny();
  // Человек — email; сервисный токен Access — common_name (Client ID).
  const user = claims.email || claims.common_name;
  if (typeof user !== 'string' || !user) throw deny();
  return user.trim().toLowerCase();
}
