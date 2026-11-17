# Сборка и деплой

Наружу Graphspace публикуется только через Cloudflare Tunnel + Cloudflare Access. На сервере
нет reverse-proxy, TLS и своей аутентификации; порт `4680` — только на loopback, к нему ходит
`cloudflared` на той же машине.

```
браузер ─▶ Cloudflare Access (вход) ─▶ Tunnel ─▶ cloudflared ─▶ 127.0.0.1:4680 graphspace
```

## Образ

`.github/workflows/ci.yml`:

- **test** — каждый push и PR: `npm test`, `npm run build`, `./setup-craft.sh`, `test:e2e` (шаг WordCraft включён).
- **image** — push в `main` и теги `v*`: образ `ghcr.io/tsuyakashi/graphspace:<sha>` (и `:<версия>` на теге).
  Craft внутри: этап `craft` в `Dockerfile` запускает тот же `setup-craft.sh`.
  Версии — label `graphspace.craft` и `/craft/versions.json`.
- **deploy-dispatch** — только `main`: `repository_dispatch` (`event_type=deploy`, `client_payload.sha`)
  в приватную `graphspace-infrastructure`. Деплой, откат и секреты — там.

Секрет репозитория: `INFRA_DISPATCH_TOKEN` — fine-grained PAT, только `graphspace-infrastructure`,
Contents: read and write.

Self-hosted runner к этой репе не подключать: она публичная, PR из форка выполнит на нём свой код.

## Обновления Craft

`craft-versions.json` — единственное место версий. Renovate (`renovate.json`) следит за релизами
`storytold/<app>` и открывает PR на каждое приложение отдельно; при зелёном CI мержит сам.
Релиз без веб-сборки роняет `setup-craft.sh` — такой PR не пройдёт. Откат версии — `git revert`.

Чтобы automerge ждал тестов: в защите ветки `main` обязательная проверка `test`.

## Вход

- Пользователь — из JWT `Cf-Access-Jwt-Assertion`: подпись RS256 по JWKS
  `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, `aud` содержит `CF_ACCESS_AUD`,
  `iss` = `CF_ACCESS_TEAM_DOMAIN`, `exp`/`nbf` с допуском 60 с.
- Без валидного JWT — 401 на всё, кроме `/healthz`. `Cf-Access-Authenticated-User-Email` без JWT не доверяется.
- Пользователь — `email` из токена (у сервисного токена — `common_name`), он же автор версий.
- `AUTH_MODE=dev` — фиксированный пользователь для разработки.
- `CF_ACCESS_TEAM_DOMAIN` и `CF_ACCESS_AUD` не секреты: JWT проверяется по публичному JWKS.

## Бэкап

Только для запуска из каталога проекта (локальный `compose.yaml`); на проде не работает, см. `docs/backlog.md`.
`./deploy/backup.sh /куда` — онлайн-снимок SQLite через `node:sqlite` `backup()` и rsync блобов
(неизменяемы, без `--delete`). Последние 30 снимков (`KEEP=`). Восстановление: остановить,
положить снимок как `data/graphspace.db`, блобы в `data/blobs/`, запустить.

## Что учесть дальше

- **Лимит загрузки.** Бесплатный Cloudflare пропускает запрос до 100 МБ, сервер принимает до 512 МБ.
- **CSRF.** Сервер читает JSON без проверки `content-type`. Держать в Access `SameSite=Lax`,
  позже добавить проверку `Origin` для запросов кроме GET.
- **WebDAV и десктоп** через Access — только сервисные токены или tailnet.
- **Права на проекты** — когда появится второй человек; логин — email из JWT.
