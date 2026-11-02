import { describe, expect, it } from 'vitest';
import { gitlabRepoOf, normalizeGitlabHost } from './gitlab.js';

describe('comptes GitLab', () => {
  it('normalise l\'adresse d\'une instance', () => {
    expect(normalizeGitlabHost('')).toBe('gitlab.com');
    expect(normalizeGitlabHost(null)).toBe('gitlab.com');
    expect(normalizeGitlabHost('GitLab.Exemple.fr')).toBe('gitlab.exemple.fr');
    expect(normalizeGitlabHost('https://gitlab.exemple.fr/')).toBe('gitlab.exemple.fr');
    expect(normalizeGitlabHost('https://gitlab.exemple.fr:8443')).toBe('gitlab.exemple.fr:8443');
    expect(normalizeGitlabHost('https://gitlab.exemple.fr/groupe')).toBeNull();
    expect(normalizeGitlabHost('ftp://gitlab.exemple.fr')).toBeNull();
  });

  it('reconnaît les dépôts gitlab.com en https et en ssh', () => {
    expect(gitlabRepoOf('https://gitlab.com/Toolso/skipper.git')).toEqual({ host: 'gitlab.com', namespace: 'toolso', path: 'Toolso/skipper' });
    expect(gitlabRepoOf('https://oauth2:x@gitlab.com/groupe/sous/projet')).toEqual({ host: 'gitlab.com', namespace: 'groupe', path: 'groupe/sous/projet' });
    expect(gitlabRepoOf('git@gitlab.com:groupe/projet.git')).toEqual({ host: 'gitlab.com', namespace: 'groupe', path: 'groupe/projet' });
    expect(gitlabRepoOf('ssh://git@gitlab.com/groupe/projet.git')?.namespace).toBe('groupe');
  });

  it('ne reconnaît une instance auto-hébergée que si un compte y est connecté', () => {
    expect(gitlabRepoOf('https://git.exemple.fr/equipe/app.git')).toBeNull();
    expect(gitlabRepoOf('https://git.exemple.fr/equipe/app.git', ['git.exemple.fr'])).toEqual({ host: 'git.exemple.fr', namespace: 'equipe', path: 'equipe/app' });
    // Le port ssh diffère du port https : l'hôte est comparé sans port.
    expect(gitlabRepoOf('git@git.exemple.fr:equipe/app.git', ['git.exemple.fr:8443'])?.host).toBe('git.exemple.fr:8443');
  });

  it('écarte les autres forges et les URL incomplètes', () => {
    expect(gitlabRepoOf('https://github.com/toolso/skipper.git')).toBeNull();
    expect(gitlabRepoOf('https://gitlab.com/toolso')).toBeNull();
    expect(gitlabRepoOf(null)).toBeNull();
  });
});
