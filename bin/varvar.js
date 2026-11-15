#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = fileURLToPath(new URL('../dist/server/cli.js', import.meta.url));
if (!existsSync(cli)) {
  console.error('varvar is not built yet. Run `npm run build` in ' + fileURLToPath(new URL('..', import.meta.url)));
  process.exit(1);
}
await import(pathToFileURL(cli).href);
