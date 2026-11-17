import fs from 'node:fs';

// Секрет из переменной или из файла по пути в <NAME>_FILE (compose secrets: /run/secrets/...).
export function secret(name) {
  if (process.env[name]) return process.env[name];
  const file = process.env[`${name}_FILE`];
  return file ? fs.readFileSync(file, 'utf8').trim() : undefined;
}
