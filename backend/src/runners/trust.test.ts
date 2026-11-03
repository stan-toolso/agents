import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeConfigFile, trustDirectories, withTrustedDirectories } from './trust.js';

describe('withTrustedDirectories', () => {
  it('ajoute les dossiers manquants sans toucher au reste ni aux réglages existants du dossier', () => {
    const current = { userID: 'u', projects: { '/w/a': { allowedTools: ['x'] }, '/w/b': { hasTrustDialogAccepted: true } } };
    expect(withTrustedDirectories(current, ['/w/a', '/w/b', '/w/c/'])).toEqual({
      userID: 'u',
      projects: { '/w/a': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/w/b': { hasTrustDialogAccepted: true }, '/w/c': { hasTrustDialogAccepted: true } },
    });
  });

  it('ne change rien quand tout est déjà « trusted »', () => {
    expect(withTrustedDirectories({ projects: { '/w/a': { hasTrustDialogAccepted: true } } }, ['/w/a'])).toBeNull();
    expect(withTrustedDirectories({}, [])).toBeNull();
  });

  it('crée la table projects quand elle manque ou est invalide', () => {
    expect(withTrustedDirectories({ projects: [] }, ['/w'])).toEqual({ projects: { '/w': { hasTrustDialogAccepted: true } } });
  });
});

describe('trustDirectories', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'trust-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('crée le fichier absent, puis fusionne sans perdre ce que le CLI y a écrit', async () => {
    const file = claudeConfigFile(dir);
    await trustDirectories(file, ['/w/main']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ projects: { '/w/main': { hasTrustDialogAccepted: true } } });
    await writeFile(file, JSON.stringify({ userID: 'u', projects: { '/w/main': { hasTrustDialogAccepted: true, lastCost: 1 } } }));
    await Promise.all([trustDirectories(file, ['/w/t1']), trustDirectories(file, ['/w/t2'])]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      userID: 'u',
      projects: { '/w/main': { hasTrustDialogAccepted: true, lastCost: 1 }, '/w/t1': { hasTrustDialogAccepted: true }, '/w/t2': { hasTrustDialogAccepted: true } },
    });
    expect(await readdir(dir)).toEqual(['.claude.json']);
  });

  it('laisse intact un fichier illisible, sans échouer', async () => {
    const file = claudeConfigFile(dir);
    await writeFile(file, '{"userID": ');
    await expect(trustDirectories(file, ['/w'])).resolves.toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('{"userID": ');
  });
});
