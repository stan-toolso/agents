import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT_PREFIX, filesUrl, resolveFilePath } from './files';

describe('resolveFilePath', () => {
  const session = { projectId: 'p', worksessionId: 'w', projectRoot: null };
  const noGit = { projectId: 'p', worksessionId: 'w', projectRoot: { projectId: 'p', worksessionId: null } };

  it('un chemin ordinaire désigne le dossier de la session', () => {
    expect(resolveFilePath(noGit, 'a/b.js')).toEqual({ ref: { projectId: 'p', worksessionId: 'w' }, rel: 'a/b.js' });
  });

  it('le préfixe @projet désigne le dossier principal quand la session en montre un', () => {
    expect(resolveFilePath(noGit, `${PROJECT_ROOT_PREFIX}/previsionnel/model3.js`)).toEqual({ ref: { projectId: 'p', worksessionId: null }, rel: 'previsionnel/model3.js' });
    expect(resolveFilePath(noGit, PROJECT_ROOT_PREFIX)).toEqual({ ref: { projectId: 'p', worksessionId: null }, rel: '' });
  });

  it("sans dossier principal montré (projet git), @projet n'est qu'un nom de dossier", () => {
    expect(resolveFilePath(session, `${PROJECT_ROOT_PREFIX}/x`)).toEqual({ ref: { projectId: 'p', worksessionId: 'w' }, rel: `${PROJECT_ROOT_PREFIX}/x` });
  });

  it("un dossier dont le nom commence par @projet n'est pas le dossier principal", () => {
    expect(resolveFilePath(noGit, '@projets/x').ref.worksessionId).toBe('w');
  });

  it("l'URL d'un fichier du dossier principal reste sous la session", () => {
    expect(filesUrl({ projectId: 'p', sessionId: 's' }, `${PROJECT_ROOT_PREFIX}/a b.js`)).toBe('/sessions/s/files/%40projet/a%20b.js');
  });
});
