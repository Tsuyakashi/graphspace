#!/usr/bin/env bash
# Ставит веб-сборки Craft-приложений в craft/<app> (раздаются с того же origin — условие моста ?host=parent).
# ./setup-craft.sh                  — офисная тройка + pdf/figma/photo
# ./setup-craft.sh wordcraft        — выборочно
# CRAFT_<APP>_TAG=v0.18.1 ./setup-craft.sh wordcraft   — закрепить версию (иначе latest)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APPS=("$@"); [ ${#APPS[@]} -eq 0 ] && APPS=(wordcraft gridcraft deckcraft pdfcraft figcraft photocraft)
mkdir -p "$ROOT/.cache/craft" "$ROOT/craft"
for a in "${APPS[@]}"; do
  tagvar="CRAFT_${a^^}_TAG"; tag="${!tagvar:-}"
  echo "== $a ${tag:-latest}"
  rm -f "$ROOT/.cache/craft/$a"-web-*.zip
  if ! gh release download ${tag:+"$tag"} -R "storytold/$a" -p "$a-web-*.zip" -D "$ROOT/.cache/craft" --clobber 2>/dev/null; then
    echo "   нет веб-сборки — пропускаю"; continue
  fi
  zip=$(ls "$ROOT/.cache/craft/$a"-web-*.zip | head -1)
  tmp=$(mktemp -d); unzip -q "$zip" -d "$tmp"
  inner=$(dirname "$(find "$tmp" -maxdepth 2 -name index.html | sort | head -1)")
  rm -rf "$ROOT/craft/$a"; mv "$inner" "$ROOT/craft/$a"; rm -rf "$tmp"
  # баг упаковки PhotoCraft 0.23.1: app/*.js ищет ./snippets, а они в корне сборки
  if [ -d "$ROOT/craft/$a/app" ] && [ -d "$ROOT/craft/$a/snippets" ] && [ ! -d "$ROOT/craft/$a/app/snippets" ]; then
    cp -r "$ROOT/craft/$a/snippets" "$ROOT/craft/$a/app/"; echo "   fix: snippets → app/snippets"
  fi
  if grep -qi "host=parent" "$ROOT/craft/$a/HOSTING.md" 2>/dev/null; then echo "   мост: есть"; else echo "   мост: НЕТ (только автономно)"; fi
  echo "   $(basename "$zip") → craft/$a"
done
