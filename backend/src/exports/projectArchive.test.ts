import { describe, expect, it } from 'vitest';
import { buildProjectArchive, parseProjectArchive, sanitizeSettings, stripCredentials, type ProjectExport } from './projectArchive.js';
import { packTarGz, unpackTarGz } from './tar.js';

const data: ProjectExport = {
  exportedAt: '2026-11-02T10:00:00.000Z',
  project: {
    name: 'Mon projet',
    slug: 'mon-projet',
    description: null,
    systemPrompt: 'Sois bref',
    gitUrl: 'https://github.com/a/b.git',
    gitBranch: 'main',
    gitHosted: false,
    runnerConfig: {},
    defaultPermissionMode: 'default',
    taskInstructions: '',
    permissionRules: [{ toolName: 'Bash', ruleContent: 'git status *' }],
    envFiles: [],
  },
  context: {
    folders: [
      { path: 'dev', name: 'Dév' },
      { path: 'dev/api', name: 'API' },
    ],
    instructions: [
      {
        path: 'dev/api/regles',
        name: 'Règles',
        description: 'Les règles',
        content: '# Règles\n',
        version: 2,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        versions: [],
      },
    ],
  },
  tasks: [],
  connections: [],
};

describe('archive de projet', () => {
  it('relit ce qu’elle écrit', () => {
    const parsed = parseProjectArchive(buildProjectArchive(data));
    expect(parsed.context).toEqual(data.context);
    expect(parsed.project).toEqual(data.project);
    expect(parsed.tasks).toEqual([]);
  });

  it('écrit les instructions en Markdown lisible et un README', () => {
    const names = unpackTarGz(buildProjectArchive(data)).map((e) => e.name);
    expect(names).toContain('mon-projet/context/dev/api/regles.md');
    expect(names).toContain('mon-projet/README.md');
  });

  it('accepte une archive réempaquetée sans dossier racine', () => {
    const flat = unpackTarGz(buildProjectArchive(data)).map((e) => ({ ...e, name: e.name.replace(/^mon-projet\//, '') }));
    expect(parseProjectArchive(packTarGz(flat)).context).toEqual(data.context);
  });

  it('refuse une archive qui n’est pas un export Skipper', () => {
    expect(() => parseProjectArchive(packTarGz([{ name: 'x/readme.md', content: Buffer.from('x') }]))).toThrow(/manifest/);
    expect(() => parseProjectArchive(packTarGz([{ name: 'x/manifest.json', content: Buffer.from('{"format":"autre"}') }]))).toThrow(/export de projet/);
    expect(() => parseProjectArchive(packTarGz([{ name: 'x/manifest.json', content: Buffer.from('{"format":"skipper-project-export","version":99}') }]))).toThrow(/plus récente/);
    expect(() => parseProjectArchive(Buffer.from('nimporte quoi'))).toThrow();
  });
});

describe('connexions sans secrets', () => {
  it('retire les identifiants des adresses', () => {
    expect(stripCredentials('https://jeton:x@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(stripCredentials('https://github.com/a/b.git')).toBe('https://github.com/a/b.git');
  });

  it('vide les champs secrets et nomme le tunnel', () => {
    const out = sanitizeSettings(
      {
        url: 'https://user:pass@site.example/login',
        fields: [
          { key: 'login', label: 'Login', secret: false, value: 'moi' },
          { key: 'password', label: 'Mot de passe', secret: true, value: 'chut' },
        ],
        viaItemId: 'id-1',
        port: 22,
      },
      new Map([['id-1', 'bastion']]),
    );
    expect(JSON.stringify(out)).not.toContain('chut');
    expect(JSON.stringify(out)).not.toContain('pass@');
    expect(out).toMatchObject({ via: 'bastion', port: 22, url: 'https://site.example/login' });
    expect(out).not.toHaveProperty('viaItemId');
  });
});
