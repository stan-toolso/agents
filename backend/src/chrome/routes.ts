import { readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { zip } from './zip.js';

/** Dossier de l'extension dans le dépôt (`backend/src/chrome` ou `backend/dist/chrome` → racine). */
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../chrome-extension');

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Archive de l'extension, avec l'adresse de ce serveur renseignée (`config.json`). */
export async function extensionZip(serverUrl = config.appUrl): Promise<Buffer> {
  // Ni la configuration par défaut (remplacée), ni la documentation, ni l'essai de bout en bout.
  const names = (await listFiles(EXTENSION_DIR)).filter((n) => n !== 'config.json' && n !== 'README.md' && !n.startsWith('test/'));
  const files = await Promise.all(names.map(async (name) => ({ name: `skipper-chrome/${name}`, data: await readFile(path.join(EXTENSION_DIR, name)) })));
  files.push({ name: 'skipper-chrome/config.json', data: Buffer.from(`${JSON.stringify({ serverUrl }, null, 2)}\n`) });
  return zip(files);
}

/** `GET /api/chrome/extension.zip` : téléchargement de l'extension (installation « non empaquetée » dans Chrome). */
export async function handleChromeRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/api/chrome/extension.zip') return false;
  try {
    const body = await extensionZip();
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="skipper-chrome.zip"', 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end("Extension introuvable sur ce serveur (dossier chrome-extension/ absent).");
  }
  return true;
}
