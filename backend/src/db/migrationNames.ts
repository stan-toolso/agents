/**
 * Convention de nommage des migrations SQL (`migrations/*.sql`).
 *
 * Les nouvelles migrations sont préfixées par un horodatage UTC à la minute (`20261101T0715_nom.sql`,
 * créé par `npm run migration:new <nom>`) : deux branches qui en ajoutent chacune une fusionnent sans
 * renumérotation, et le tri lexical reste correct car `0xx_` < `2026…`. Les fichiers numérotés
 * historiques (`001_` à `054_`) ne bougent pas : leur nom est enregistré dans `schema_migrations`.
 */

/** Dernier numéro de l'ancienne convention : aucun nouveau fichier `NNN_` au-delà. */
export const LAST_LEGACY_NUMBER = 54;

/** Numéros historiques partagés par deux fichiers, antérieurs à la convention : tolérés, sans en ajouter. */
export const LEGACY_DUPLICATE_PREFIXES = new Set(['011', '013', '014', '015', '020', '034', '043']);

const LEGACY_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const TIMESTAMP_RE = /^(\d{8}T\d{4})_[a-z0-9_]+\.sql$/;

/** Préfixe d'ordre d'un fichier de migration (`015`, `20261101T0715`), ou null s'il ne suit aucune convention. */
export function migrationPrefix(file: string): string | null {
  return (TIMESTAMP_RE.exec(file) ?? LEGACY_RE.exec(file))?.[1] ?? null;
}

/** Vérifie un horodatage `AAAAMMJJTHHMM` (date et heure réelles). */
function validTimestamp(prefix: string): boolean {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(prefix);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && h < 24 && mi < 60;
}

/** Erreurs de nommage d'un ensemble de fichiers de migration (vide si tout va bien). */
export function checkMigrationNames(files: string[]): string[] {
  const errors: string[] = [];
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = migrationPrefix(file);
    if (!prefix) {
      errors.push(`${file} : nom invalide, attendu AAAAMMJJTHHMM_nom.sql (npm run migration:new <nom>)`);
      continue;
    }
    if (prefix.includes('T')) {
      if (!validTimestamp(prefix)) errors.push(`${file} : horodatage invalide`);
    } else if (Number(prefix) > LAST_LEGACY_NUMBER) {
      errors.push(`${file} : la numérotation NNN_ est figée à ${LAST_LEGACY_NUMBER}, utiliser npm run migration:new <nom>`);
    }
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
  }
  for (const [prefix, same] of byPrefix) {
    if (same.length > 1 && !(LEGACY_DUPLICATE_PREFIXES.has(prefix) && same.length === 2)) {
      errors.push(`préfixe ${prefix} partagé par ${same.join(', ')}`);
    }
  }
  return errors;
}

/**
 * Migrations ajoutées par une branche (absentes de `base`) qui se classent avant la dernière migration de
 * `base` : en production elles seraient appliquées après des migrations plus récentes qu'elles.
 */
export function addedBeforeLatest(base: string[], branch: string[]): string[] {
  const latest = [...base].sort().at(-1);
  if (!latest) return [];
  const known = new Set(base);
  return branch.filter((f) => !known.has(f) && f < latest).sort();
}

/** Nom d'une nouvelle migration : horodatage UTC à la minute et nom en minuscules sans accents. */
export function newMigrationName(name: string, now = new Date()): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('Nom de migration vide');
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `${stamp}_${slug}.sql`;
}
