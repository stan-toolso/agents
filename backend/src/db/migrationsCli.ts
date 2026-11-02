import { execFileSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { addedBeforeLatest, checkMigrationNames, newMigrationName } from './migrationNames.js';

/**
 * Outils de développement des migrations :
 * - `npm run migration:new <nom>` crée `migrations/AAAAMMJJTHHMM_nom.sql` (horodatage UTC) ;
 * - `npm run check:migrations -w backend [-- <ref>]` échoue sur un nom invalide ou un préfixe en double, et
 *   avertit (annotation GitHub en CI) si la branche ajoute une migration plus ancienne que la dernière de `<ref>`.
 */

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const listFiles = async () => (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const annotate = (level: 'error' | 'warning', message: string) =>
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level === 'error' ? 'Erreur' : 'Avertissement'} : ${message}`);

/** Fichiers de migration d'une référence git (vide si la référence est inconnue). */
function filesAt(ref: string): string[] | null {
  const repoDir = path.relative(
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: migrationsDir, encoding: 'utf8' }).trim(),
    migrationsDir,
  );
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${repoDir}`], { cwd: migrationsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((f) => f.endsWith('.sql'));
  } catch {
    return null;
  }
}

async function create(name: string | undefined) {
  if (!name) throw new Error('Usage : npm run migration:new <nom>');
  const file = newMigrationName(name);
  const existing = await listFiles();
  if (existing.includes(file)) throw new Error(`${file} existe déjà`);
  await writeFile(path.join(migrationsDir, file), `-- ${name}\n`, { flag: 'wx' });
  console.log(path.relative(process.cwd(), path.join(migrationsDir, file)));
}

async function check(ref = 'origin/main') {
  const files = await listFiles();
  const errors = checkMigrationNames(files);
  for (const e of errors) annotate('error', e);
  const base = filesAt(ref);
  if (!base) annotate('warning', `référence ${ref} introuvable : ordre des migrations non comparé`);
  else {
    for (const f of addedBeforeLatest(base, files)) {
      annotate('warning', `${f} se classe avant la dernière migration de ${ref} : elle sera appliquée hors ordre en production (recréer avec npm run migration:new)`);
    }
  }
  if (errors.length) process.exitCode = 1;
  else console.log(`${files.length} migrations, nommage correct`);
}

const [command, ...args] = process.argv.slice(2);
const arg = args.join(' ') || undefined;
(command === 'new' ? create(arg) : command === 'check' ? check(arg) : Promise.reject(new Error('Commandes : new <nom>, check [ref]'))).catch(
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
