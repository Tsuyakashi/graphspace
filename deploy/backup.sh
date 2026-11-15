#!/usr/bin/env bash
# Бэкап: онлайн-снимок SQLite + блобы. Блобы неизменяемы (имя = sha256), поэтому rsync без --delete.
# ./deploy/backup.sh /mnt/backup/graphspace      — из каталога проекта на ВМ, сервер работает
# Восстановление: остановить compose, положить снимок как data/graphspace.db, блобы в data/blobs.
set -euo pipefail
DEST="${1:?куда класть бэкап}"
KEEP="${KEEP:-30}" # сколько снимков базы хранить
cd "$(dirname "$0")/.."
stamp="$(date +%F-%H%M%S)"
mkdir -p "$DEST/db" "$DEST/blobs"

docker compose exec -T graphspace node --input-type=module -e "
  import { DatabaseSync, backup } from 'node:sqlite';
  const db = new DatabaseSync('/data/graphspace.db');
  await backup(db, '/data/backup.db');
  db.close();"
mv data/backup.db "$DEST/db/graphspace-$stamp.db"
rsync -a data/blobs/ "$DEST/blobs/"

ls -1t "$DEST"/db/graphspace-*.db | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "бэкап: $DEST/db/graphspace-$stamp.db"
