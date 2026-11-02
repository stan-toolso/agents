import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';
import { log } from '../log.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applique, dans l'ordre alphabétique, les fichiers .sql de `migrations/`
 * qui n'ont pas encore été enregistrés dans `schema_migrations`.
 *
 * Une migration qui se classe avant la dernière déjà appliquée l'est quand même (branche fusionnée après
 * une autre), mais avec un avertissement : elle passe après des migrations plus récentes qu'elle.
 * Convention de nommage : migrationNames.ts.
 */
export async function runMigrations(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const latestDone = [...done].sort().at(-1);
    for (const file of files) {
      if (done.has(file)) continue;
      if (latestDone && file < latestDone) {
        log.warn(`[db] migration ${file} appliquée hors ordre : ${latestDone} l'a été avant elle`);
      }
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} échouée : ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    client.release();
  }
}

// Exécution directe : `npm run migrate -w backend`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then((applied) => {
      log.info(applied.length ? `[db] migrations appliquées : ${applied.join(', ')}` : '[db] base déjà à jour');
      return pool.end();
    })
    .catch((err) => {
      log.error(err);
      process.exit(1);
    });
}
