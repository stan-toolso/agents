import { slugify } from '../projects/slug.js';

/** Longueur maximale du libellé d'une work session. */
export const LABEL_MAX = 100;

/** `base`, ou `base-2`, `base-3`… quand une work session de la liste le porte déjà. */
export function uniqueName(worksessions: { name: string }[], base: string): string {
  const taken = new Set(worksessions.map((w) => w.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}-${i}`;
  return name;
}

/**
 * Nom de dossier et branche dérivés (pas choisis) rendus libres ensemble : `base`/`branchBase`, sinon
 * `base-2`/`branchBase-2`… jusqu'à ce que le dossier ne soit porté par aucune work session et que la branche
 * n'existe pas (localement, sur origin, ou extraite dans un autre dossier de travail). Une consigne qui commence
 * comme une autre (le même lien, par exemple) ne doit ni échouer ni reprendre la branche d'un autre travail.
 */
export function uniqueNameAndBranch(
  base: string,
  branchBase: string,
  takenNames: Iterable<string>,
  takenBranches: Iterable<string>,
): { name: string; branch: string } {
  const names = new Set(takenNames);
  const branches = new Set(takenBranches);
  let name = base;
  let branch = branchBase;
  for (let i = 2; names.has(name) || branches.has(branch); i++) {
    name = `${base.slice(0, 60)}-${i}`;
    branch = `${branchBase.slice(0, 60)}-${i}`;
  }
  return { name, branch };
}

/**
 * Noms d'une work session dérivés de ce dont elle parle (première consigne de sa session, titre d'une
 * tâche) : le libellé est la première ligne, le dossier (et la branche) un slug de ses premiers mots.
 * Pur : le frontend en a le miroir (`frontend/src/lib/worksessions.ts`).
 */
export function namesFromText(text: string, prefix = ''): { label: string; name: string } {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  const words = slugify(line).split('-').filter(Boolean);
  let slug = '';
  for (const w of words) {
    if (slug && (slug.length + 1 + w.length > 40 || slug.split('-').length >= 6)) break;
    slug = slug ? `${slug}-${w}` : w.slice(0, 40);
  }
  return { label: line, name: `${prefix}${slug || 'travail'}` };
}
