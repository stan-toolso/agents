#!/usr/bin/env node
// Les mêmes contrôles que la CI GitHub (.github/workflows/ci.yml), en parallèle, depuis un dossier de travail qui a déjà
// ses dépendances : `npm run ci`. Lancé par Skipper avant d'ouvrir une pull request (.skipper/ci.json).
//
//   npm run ci              tout, en parallèle
//   npm run ci -- --serial  une étape à la fois (conteneur à peu de mémoire)
//
// Variables : CI_SERIAL=1 (comme --serial) ; TEST_DATABASE_URL (sinon un PostgreSQL jetable est installé par npm
// dans le dossier temporaire et démarré le temps du run ; CI_EMBEDDED_PG=0 pour ne pas le faire : le test des
// migrations est alors ignoré, et le dit).
// Code de sortie : 0 si tout passe, 1 sinon. Les journaux des étapes en échec sont affichés en entier à la fin.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.argv.includes('--serial') || process.env.CI_SERIAL === '1';
const PG_VERSION = '16.14.0-beta.17'; // version exacte : la plage @16 échoue (voir l'instruction dev/tests)

function run(name, cmd, { env = {}, cwd = root } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', (code) => resolve({ name, ok: code === 0, seconds: (Date.now() - started) / 1000, log }));
    child.on('error', (err) => resolve({ name, ok: false, seconds: (Date.now() - started) / 1000, log: String(err) }));
  });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

/** PostgreSQL jetable (paquet npm embarqué, installé une fois dans le dossier temporaire puis réutilisé). */
async function startEmbeddedPostgres() {
  const arch = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x64' : null;
  if (process.platform !== 'linux' || !arch) throw new Error(`plateforme non gérée (${process.platform}/${os.arch()})`);
  const base = path.join(os.tmpdir(), `skipper-ci-pg-${os.userInfo().username}`);
  const pkg = path.join(base, 'node_modules', '@embedded-postgres', `linux-${arch}`, 'native');
  if (!existsSync(pkg)) {
    mkdirSync(base, { recursive: true });
    execFileSync('npm', ['init', '-y'], { cwd: base, stdio: 'ignore' });
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', `@embedded-postgres/linux-${arch}@${PG_VERSION}`], { cwd: base, stdio: 'ignore' });
  }
  const env = { ...process.env, LD_LIBRARY_PATH: path.join(pkg, 'lib') };
  const data = mkdtempSync(path.join(base, 'data-'));
  const port = await freePort();
  execFileSync(path.join(pkg, 'bin', 'initdb'), ['-D', data, '-U', 'skipper', '--auth=trust', '-E', 'UTF8', '--no-locale'], { env, stdio: 'ignore' });
  execFileSync(path.join(pkg, 'bin', 'pg_ctl'), ['-D', data, '-l', path.join(data, 'pg.log'), '-o', `-p ${port} -k ${data} -c listen_addresses=127.0.0.1 -c shared_buffers=16MB -c max_connections=20`, '-w', 'start'], { env, stdio: 'ignore' });
  return {
    url: `postgres://skipper:skipper@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        execFileSync(path.join(pkg, 'bin', 'pg_ctl'), ['-D', data, '-m', 'fast', 'stop'], { env, stdio: 'ignore' });
      } catch {
        /* déjà arrêté */
      }
      rmSync(data, { recursive: true, force: true });
    },
  };
}

async function main() {
  const started = Date.now();
  let pg = null;
  let dbUrl = process.env.TEST_DATABASE_URL;
  let note = '';
  if (!dbUrl && process.env.CI_EMBEDDED_PG !== '0') {
    try {
      pg = await startEmbeddedPostgres();
      dbUrl = pg.url;
    } catch (err) {
      note = `PostgreSQL jetable indisponible (${err.message.split('\n')[0]}) : test des migrations ignoré`;
    }
  } else if (!dbUrl) {
    note = 'TEST_DATABASE_URL absent et CI_EMBEDDED_PG=0 : test des migrations ignoré';
  }

  // Mêmes étapes que .github/workflows/ci.yml. Le build du frontend contient déjà son typecheck.
  const steps = [
    ['migrations', 'git fetch --no-tags --depth=1 origin main 2>/dev/null; npm run check:migrations -w backend -- origin/main', {}],
    ['backend typecheck + build', 'npm run typecheck -w backend && npm run build -w backend', {}],
    ['frontend typecheck + build', 'npm run build -w frontend', {}],
    ['tests', 'npm run test -w backend && npm run test -w frontend', dbUrl ? { TEST_DATABASE_URL: dbUrl } : {}],
  ];
  const results = [];
  try {
    if (serial) for (const [n, c, env] of steps) results.push(await run(n, c, { env }));
    else results.push(...(await Promise.all(steps.map(([n, c, env]) => run(n, c, { env })))));
  } finally {
    pg?.stop();
  }

  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${r.seconds.toFixed(0)} s)`);
  if (note) console.log(`! ${note}`);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`\n===== ${r.name} =====\n${r.log.trimEnd()}`);
  console.log(`\n${failed.length ? `ÉCHEC : ${failed.map((r) => r.name).join(', ')}` : 'OK'} en ${((Date.now() - started) / 1000).toFixed(0)} s${serial ? ' (étapes en série)' : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
