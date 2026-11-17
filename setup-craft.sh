#!/usr/bin/env bash
# Ставит веб-сборки Craft-приложений в craft/<app> (раздаются с того же origin — условие моста ?host=parent).
# Версии — из craft-versions.json, их поднимает Renovate. Тот же скрипт запускает Dockerfile.
# ./setup-craft.sh               — все приложения из craft-versions.json
# ./setup-craft.sh wordcraft     — выборочно
# Нужны curl, jq, unzip. GITHUB_TOKEN — по желанию: без него API GitHub даёт 60 запросов в час.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSIONS="$ROOT/craft-versions.json"
APPS=("$@"); [ ${#APPS[@]} -eq 0 ] && mapfile -t APPS < <(jq -r 'keys_unsorted[]' "$VERSIONS")
auth=(); [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
mkdir -p "$ROOT/.cache/craft" "$ROOT/craft"
for a in "${APPS[@]}"; do
  tag=$(jq -er --arg a "$a" '.[$a]' "$VERSIONS") || { echo "$a: нет в craft-versions.json" >&2; exit 1; }
  echo "== $a $tag"
  url=$(curl -fsSL "${auth[@]}" "https://api.github.com/repos/storytold/$a/releases/tags/$tag" \
    | jq -r --arg a "$a" '[.assets[] | select(.name | test("^" + $a + "-web-.*\\.zip$")) | .browser_download_url][0] // empty')
  # Нет веб-сборки в закреплённом релизе — ошибка, а не пропуск: PR Renovate на такой релиз не пройдёт CI.
  [ -n "$url" ] || { echo "   нет веб-сборки в $tag" >&2; exit 1; }
  zip="$ROOT/.cache/craft/$a-$tag.zip"
  [ -f "$zip" ] || curl -fsSL -o "$zip" "$url"
  tmp=$(mktemp -d); unzip -q "$zip" -d "$tmp"
  inner=$(dirname "$(find "$tmp" -maxdepth 2 -name index.html | sort | head -1)")
  rm -rf "$ROOT/craft/$a"; mv "$inner" "$ROOT/craft/$a"; rm -rf "$tmp"
  # баг упаковки PhotoCraft 0.23.1: app/*.js ищет ./snippets, а они в корне сборки
  if [ -d "$ROOT/craft/$a/app" ] && [ -d "$ROOT/craft/$a/snippets" ] && [ ! -d "$ROOT/craft/$a/app/snippets" ]; then
    cp -r "$ROOT/craft/$a/snippets" "$ROOT/craft/$a/app/"; echo "   fix: snippets → app/snippets"
  fi
  if grep -qi "host=parent" "$ROOT/craft/$a/HOSTING.md" 2>/dev/null; then echo "   мост: есть"; else echo "   мост: НЕТ (только автономно)"; fi
done
cp "$VERSIONS" "$ROOT/craft/versions.json"
