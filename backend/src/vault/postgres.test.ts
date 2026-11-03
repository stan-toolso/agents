import { describe, expect, it, vi } from 'vitest';
import { connectionErrorMessage, databasesSql, MAINTENANCE_DATABASE, rdsBundleUrl, rdsRegion, sslConfig, validateDatabaseName } from './postgres.js';

describe('validateDatabaseName', () => {
  it('accepte un identifiant simple, espaces retirés', () => {
    expect(validateDatabaseName(' skipper ')).toBe('skipper');
    expect(validateDatabaseName('skipper-test_2')).toBe('skipper-test_2');
    expect(validateDatabaseName('42bis')).toBe('42bis');
  });
  it('refuse le vide, les espaces, les guillemets et les noms trop longs', () => {
    for (const bad of ['', '  ', 'ma base', 'a"b', "a'b", 'a;b', 'a.b', 'é', 'x'.repeat(64)]) {
      expect(() => validateDatabaseName(bad), bad).toThrow(/invalide/);
    }
    expect(() => validateDatabaseName(null)).toThrow(/invalide/);
  });
  it('nomme le champ dans le message', () => {
    expect(() => validateDatabaseName('a b', 'Le nom de la nouvelle base')).toThrow(/^Le nom de la nouvelle base est invalide/);
  });
});

describe('databasesSql', () => {
  it('exclut les bases interdites de connexion et ne mesure que celles accessibles', () => {
    const sql = databasesSql();
    expect(sql).toContain('d.datallowconn');
    expect(sql).toContain("has_database_privilege(d.datname, 'CONNECT')");
  });
  it('la base de maintenance par défaut est postgres', () => {
    expect(MAINTENANCE_DATABASE).toBe('postgres');
  });
});

describe('connectionErrorMessage', () => {
  const creds = { username: 'u', host: 'h', port: 5432, database: 'd', sslCa: null };
  const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });

  it('indique de fournir l\'autorité quand la chaîne est inconnue', () => {
    expect(connectionErrorMessage(creds, tlsError)).toMatch(/^Connexion PostgreSQL à u@h:5432\/d impossible : self-signed.*collez le certificat de l'autorité/);
  });

  it('signale une autorité fournie qui ne valide pas la chaîne', () => {
    expect(connectionErrorMessage({ ...creds, sslCa: '-----BEGIN CERTIFICATE-----' }, tlsError)).toMatch(/ne valide pas la chaîne/);
  });

  it('laisse les autres erreurs telles quelles', () => {
    expect(connectionErrorMessage(creds, new Error('timeout'))).toBe('Connexion PostgreSQL à u@h:5432/d impossible : timeout');
  });
});

describe('rdsRegion', () => {
  it('lit la région d\'un point de terminaison RDS', () => {
    expect(rdsRegion('toolso-campaign-manager.cvnflahvtvq1.eu-west-1.rds.amazonaws.com')).toBe('eu-west-1');
    expect(rdsRegion('db.abc.ap-southeast-2.rds.amazonaws.com.')).toBe('ap-southeast-2');
    expect(rdsRegion('cluster-ro-x.cluster-abc.us-east-1.rds.amazonaws.com')).toBe('us-east-1');
  });
  it('ignore les autres hôtes', () => {
    expect(rdsRegion('51.158.36.16')).toBeNull();
    expect(rdsRegion('db.example.com')).toBeNull();
    expect(rdsRegion('rds.amazonaws.com.evil.example')).toBeNull();
  });
});

describe('sslConfig', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const okFetch = vi.fn(async () => new Response(pem)) as unknown as typeof fetch;

  it('sans SSL : false', async () => {
    expect(await sslConfig({ ssl: false, sslCa: null, host: 'h' })).toBe(false);
  });
  it('le certificat de l\'élément prime, sans contrôle du nom', async () => {
    const ssl = (await sslConfig({ ssl: true, sslCa: pem, host: 'x.abc.eu-west-1.rds.amazonaws.com' }, okFetch)) as Record<string, unknown>;
    expect(ssl.ca).toBe(pem);
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });
  it('hôte RDS sans certificat : bundle de la région, nom d\'hôte vérifié', async () => {
    const f = vi.fn(async () => new Response(pem)) as unknown as typeof fetch;
    const ssl = (await sslConfig({ ssl: true, sslCa: null, host: 'x.abc.eu-north-1.rds.amazonaws.com' }, f)) as Record<string, unknown>;
    expect(f).toHaveBeenCalledWith(rdsBundleUrl('eu-north-1'), expect.anything());
    expect(ssl).toMatchObject({ ca: pem, rejectUnauthorized: true, servername: 'x.abc.eu-north-1.rds.amazonaws.com' });
    expect(ssl.checkServerIdentity).toBeUndefined();
    // Gardé en cache : pas de second téléchargement.
    await sslConfig({ ssl: true, sslCa: null, host: 'y.abc.eu-north-1.rds.amazonaws.com' }, f);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('téléchargement en échec : autorités publiques, et réessai à la connexion suivante', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await sslConfig({ ssl: true, sslCa: null, host: 'x.abc.sa-east-1.rds.amazonaws.com' }, bad)).toEqual({ rejectUnauthorized: true });
    await new Promise((r) => setTimeout(r, 0));
    const ssl = (await sslConfig({ ssl: true, sslCa: null, host: 'x.abc.sa-east-1.rds.amazonaws.com' }, okFetch)) as Record<string, unknown>;
    expect(ssl.ca).toBe(pem);
  });
  it('hôte ordinaire : autorités publiques', async () => {
    expect(await sslConfig({ ssl: true, sslCa: null, host: 'db.example.com' }, okFetch)).toEqual({ rejectUnauthorized: true });
  });
});
