import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGz, unpackTarGz } from './tar.js';

const longName = `projet/context/${'dossier-tres-long/'.repeat(8)}règles-é.md`;
const entries = [
  { name: 'projet/manifest.json', content: Buffer.from('{"a":1}\n') },
  { name: longName, content: Buffer.from('# Règles\n\ncontenu accentué : é à ü\n') },
  { name: 'projet/vide.txt', content: Buffer.alloc(0) },
  { name: 'projet/bloc.bin', content: Buffer.alloc(512, 7) },
];

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const hasTar = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('tar.gz', () => {
  it('relit ce qu’il écrit, noms longs et accentués compris', () => {
    const out = unpackTarGz(packTarGz(entries));
    expect(out.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    out.forEach((e, i) => expect(e.content.equals(entries[i].content)).toBe(true));
  });

  it('refuse ce qui n’est pas une archive tar', () => {
    expect(() => unpackTarGz(Buffer.from('pas une archive'.repeat(50)))).toThrow();
  });

  it.skipIf(!hasTar)('produit une archive que tar sait extraire', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'skipper-tar-'));
    await writeFile(path.join(dir, 'a.tar.gz'), packTarGz(entries));
    execFileSync('tar', ['xzf', 'a.tar.gz'], { cwd: dir });
    expect(await readFile(path.join(dir, longName), 'utf8')).toContain('accentué');
    expect((await readFile(path.join(dir, 'projet/bloc.bin'))).length).toBe(512);
  });

  it.skipIf(!hasTar)('lit une archive faite par tar', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'skipper-tar-'));
    await mkdir(path.join(dir, 'src', 'p', 'sous'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'p', 'manifest.json'), '{}');
    await writeFile(path.join(dir, 'src', 'p', 'sous', `${'n'.repeat(120)}é.md`), 'x');
    execFileSync('tar', ['czf', '../a.tar.gz', 'p'], { cwd: path.join(dir, 'src') });
    const out = unpackTarGz(await readFile(path.join(dir, 'a.tar.gz')));
    expect(out.map((e) => e.name).sort()).toEqual(['p/manifest.json', `p/sous/${'n'.repeat(120)}é.md`]);
  });
});
