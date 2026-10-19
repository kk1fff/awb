#!/bin/sh
set -eu
APP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ ! -x "$APP_ROOT/node_modules/.bin/tsc" ]; then
  npm --prefix "$APP_ROOT" ci
fi
if ! (cd "$APP_ROOT" && node --input-type=module -e 'import { chromium } from "playwright"; import { existsSync } from "node:fs"; process.exit(existsSync(chromium.executablePath()) ? 0 : 1)'); then
  (cd "$APP_ROOT" && npx playwright install chromium)
fi
npm --prefix "$APP_ROOT" run build
FIELDWORK_APP_ROOT="$APP_ROOT" exec node "$APP_ROOT/dist/server/server/launcher.js" "$@"
