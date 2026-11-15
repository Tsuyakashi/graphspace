# Деплой

ВМ с Ubuntu, Docker и compose. Наружу Graphspace публикуется только через Cloudflare Tunnel + Cloudflare Access. В compose один сервис `graphspace`: без reverse-proxy, без TLS, без своей аутентификации.

```
браузер ──▶ Cloudflare Access (вход) ──▶ Tunnel ──▶ cloudflared на ВМ ──▶ 127.0.0.1:4680 graphspace
                                                                                 ├─ ./data  (SQLite + блобы)
                                                                                 └─ ./craft (веб-сборки, только чтение)
```

- **Порт 4680** опубликован только на loopback ВМ (`127.0.0.1:4680`). К нему ходит `cloudflared`, запущенный на этой же ВМ. Ни одного порта на `0.0.0.0`.
- **cloudflared, DNS и политики Access** настраиваются отдельно и в этот репозиторий не входят. Ingress туннеля для Graphspace — `http://127.0.0.1:4680`.

## Вход

- Пользователь определяется по JWT из заголовка `Cf-Access-Jwt-Assertion`, который Access добавляет к каждому запросу.
- Сервер проверяет:
  - подпись RS256 по JWKS `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`. Ключи кешируются, при незнакомом `kid` перечитываются, но не чаще раза в минуту;
  - `aud` содержит `CF_ACCESS_AUD`;
  - `iss` = `CF_ACCESS_TEAM_DOMAIN`;
  - срок действия `exp` и `nbf` с допуском 60 с.
- Без валидного JWT — 401 на всё: интерфейс, `/api`, `/craft`. Исключение — `/healthz` для Docker, он ничего не раскрывает.
- Заголовку `Cf-Access-Authenticated-User-Email` без JWT сервер не верит.
- Пользователь — `email` из токена. У сервисного токена Access это `common_name`. Он же автор версий.
- `AUTH_MODE=dev` включает фиксированного пользователя для локальной разработки (`AUTH_DEV_USER`, по умолчанию `dev@localhost`). По умолчанию выключен. В обычном режиме без `CF_ACCESS_TEAM_DOMAIN` и `CF_ACCESS_AUD` сервер не стартует.

## Первый запуск

1. **Docker:**
   ```bash
   sudo apt install docker.io docker-compose-v2 rsync
   sudo usermod -aG docker $USER   # перелогиниться
   ```
2. **Код и Craft.** `setup-craft.sh` нужен `gh` с логином. Можно собрать `craft/` на рабочей машине и скопировать через rsync.
   ```bash
   git clone git@github.com:Tsuyakashi/graphspace.git && cd graphspace
   ./setup-craft.sh
   mkdir -p data   # до первого up, иначе Docker создаст его от root и сервер не сможет писать
   ```
3. **Настройки.** `cp .env.example .env` и заполнить:
   - `CF_ACCESS_TEAM_DOMAIN` — `https://<team>.cloudflareaccess.com`;
   - `CF_ACCESS_AUD` — Application Audience (AUD) Tag приложения: Zero Trust → Access → Applications;
   - `GRAPHSPACE_UID`/`GRAPHSPACE_GID` — `id -u`/`id -g`, для rootless Docker — `0`.
4. **Запуск.**
   ```bash
   docker compose up -d --build
   curl -i 127.0.0.1:4680/healthz   # 200
   curl -i 127.0.0.1:4680/          # 401 — без Access так и должно быть
   ```

Обновление: `git pull && docker compose up -d --build`. Демо-набор в проде не создаётся (`GRAPHSPACE_SEED=0` в образе).

## Бэкап

`./deploy/backup.sh /куда` делает онлайн-снимок SQLite через `node:sqlite` `backup()`, сервер останавливать не нужно. Блобы копируются через rsync без `--delete`: они неизменяемы. Хранятся последние 30 снимков базы (`KEEP=`).

Cron на ВМ, раз в ночь:
```
15 3 * * *  cd /home/tsu/graphspace && ./deploy/backup.sh /mnt/backup/graphspace >> /var/log/graphspace-backup.log 2>&1
```
Бэкап должен лежать не на той же ВМ: NFS с PVE, MinIO через `rclone` или отдельный диск.

Восстановление: `docker compose down`, снимок кладётся как `data/graphspace.db`, блобы — в `data/blobs/`, затем `up -d`.

## Что учесть дальше

- **Лимит загрузки.** Бесплатный тариф Cloudflare пропускает запрос не больше 100 МБ. Сервер принимает до 512 МБ, но через туннель большой файл не пройдёт.
- **Подделка запросов с чужих сайтов.** Сервер читает JSON, не проверяя `content-type`. Если cookie `CF_Authorization` выставлена с `SameSite=None`, чужая страница сможет отправить форму от моего имени. Держать в Access `SameSite=Lax` и позже добавить на сервере проверку `Origin` для запросов кроме GET.
- **WebDAV и десктоп** (бэклог, п. 5) через Access идут только с сервисными токенами (`CF-Access-Client-Id`/`Secret`) или через tailnet.
- **Права на проекты** (`members(root_id, login, role)`) — когда появится второй человек. Логин — тот же email из JWT.
