import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addedBeforeLatest, checkMigrationNames, migrationPrefix, newMigrationName } from './migrationNames.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

describe('migrations du dépôt', () => {
  it('suivent la convention de nommage, sans préfixe en double', async () => {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
    expect(checkMigrationNames(files)).toEqual([]);
  });
});

describe('checkMigrationNames', () => {
  it('accepte les numéros historiques et les horodatages', () => {
    expect(checkMigrationNames(['001_init.sql', '054_agents.sql', '20261101T0715_task_deps.sql'])).toEqual([]);
  });

  it('tolère les doublons historiques connus, pas un troisième fichier', () => {
    expect(checkMigrationNames(['015_a.sql', '015_b.sql'])).toEqual([]);
    expect(checkMigrationNames(['015_a.sql', '015_b.sql', '015_c.sql'])).toHaveLength(1);
  });

  it('refuse un nouveau préfixe en double', () => {
    expect(checkMigrationNames(['20261101T0715_a.sql', '20261101T0715_b.sql'])).toEqual([
      'préfixe 20261101T0715 partagé par 20261101T0715_a.sql, 20261101T0715_b.sql',
    ]);
    expect(checkMigrationNames(['012_a.sql', '012_b.sql'])).toHaveLength(1);
  });

  it('refuse un nouveau numéro NNN_, un nom hors convention et une date impossible', () => {
    expect(checkMigrationNames(['055_suite.sql'])).toHaveLength(1);
    expect(checkMigrationNames(['nouvelle.sql', '20261101T0715_Majuscule.sql'])).toHaveLength(2);
    expect(checkMigrationNames(['20261332T0715_x.sql', '20261101T2460_x.sql'])).toHaveLength(2);
  });

  it('classe les horodatages après les numéros historiques', () => {
    expect(['20261101T0715_x.sql', '054_agents.sql'].sort()).toEqual(['054_agents.sql', '20261101T0715_x.sql']);
    expect(migrationPrefix('054_agents.sql')).toBe('054');
    expect(migrationPrefix('20261101T0715_x.sql')).toBe('20261101T0715');
  });
});

describe('addedBeforeLatest', () => {
  const main = ['054_agents.sql', '20261101T0900_b.sql'];

  it('signale une migration ajoutée plus ancienne que la dernière de main', () => {
    expect(addedBeforeLatest(main, [...main, '20261101T0800_a.sql'])).toEqual(['20261101T0800_a.sql']);
  });

  it('ignore les migrations ajoutées plus récentes et celles déjà sur main', () => {
    expect(addedBeforeLatest(main, [...main, '20261102T0800_c.sql'])).toEqual([]);
    expect(addedBeforeLatest([], ['001_init.sql'])).toEqual([]);
  });
});

describe('newMigrationName', () => {
  it('horodate en UTC à la minute et normalise le nom', () => {
    expect(newMigrationName('Dépendances des tâches', new Date('2026-11-02T07:05:59Z'))).toBe(
      '20261102T0705_dependances_des_taches.sql',
    );
  });

  it('refuse un nom vide', () => {
    expect(() => newMigrationName(' -- ')).toThrow();
  });
});
