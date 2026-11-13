import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, NotFoundError } from '../errors.js';
import { log } from '../log.js';
import { decryptSecret, encryptSecret } from '../settings/crypto.js';
import { createBatcher } from './batcher.js';
import { categoryOf, PUSH_CATEGORIES } from './preferences.js';
import { CHANNEL_KINDS, deliver, validateTarget, type ChannelKind, type OutgoingItem } from './transports.js';
import type { Notification } from './types.js';

/**
 * Canaux de notification hors navigateur (table notification_channels) : webhook Slack ou Discord, e-mail.
 * Branchés sur notificationService.notify à côté du Web Push : chaque notification est relayée aux canaux du
 * projet (notifications adressées à tous ses membres) et aux canaux personnels des personnes qui la verraient
 * dans leur cloche, pour les familles choisies (PUSH_CATEGORIES). Anti-rafale par canal (batcher.ts) :
 * regroupement sur une minute, sauf les demandes d'un agent qui partent aussitôt.
 */

export interface NotificationChannel {
  id: string;
  projectId: string | null;
  userId: string | null;
  kind: ChannelKind;
  /** Cible lisible sans secret (hôte du webhook, adresse e-mail). */
  targetHint: string;
  categories: string[];
  enabled: boolean;
  lastSentAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  project_id: string | null;
  user_id: string | null;
  kind: ChannelKind;
  target: string;
  target_hint: string;
  categories: string[];
  enabled: boolean;
  last_sent_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

const toChannel = (r: Row): NotificationChannel => ({
  id: r.id,
  projectId: r.project_id,
  userId: r.user_id,
  kind: r.kind,
  targetHint: r.target_hint,
  categories: r.categories ?? [],
  enabled: r.enabled,
  lastSentAt: r.last_sent_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});

/** Familles relayées par défaut à la création d'un canal. */
export const DEFAULT_CHANNEL_CATEGORIES = ['requests', 'sessions', 'tasks', 'budget', 'artifact_alerts'];

export const BATCH_WINDOW_MS = 60_000;

/** Familles qu'un canal peut relayer : celles réservées aux administrateurs seulement pour le canal personnel d'un administrateur. */
export function allowedCategories(owner: { projectId: string | null; admin: boolean }): string[] {
  return PUSH_CATEGORIES.filter((c) => !c.adminsOnly || (!owner.projectId && owner.admin)).map((c) => c.key);
}

function normalizeCategories(categories: string[] | null | undefined, allowed: string[]): string[] {
  if (categories == null) return DEFAULT_CHANNEL_CATEGORIES.filter((c) => allowed.includes(c));
  const unknown = categories.filter((c) => !allowed.includes(c));
  if (unknown.length) throw new AppError(`Famille de notifications inconnue ou non permise : ${unknown.join(', ')}`);
  return [...new Set(categories)].sort();
}

export interface ChannelInput {
  kind: string;
  target: string;
  categories?: string[] | null;
}

export interface ChannelPatch {
  target?: string | null;
  categories?: string[] | null;
  enabled?: boolean | null;
}

/** Lien absolu vers une page de l'application. */
export const absoluteLink = (link: string | null): string => {
  const path = link && link.startsWith('/') && !link.startsWith('//') ? link : '/';
  return `${config.appUrl}${path}`;
};

export const notificationChannelRepository = {
  async findById(id: string): Promise<Row | null> {
    const { rows } = await pool.query<Row>('SELECT * FROM notification_channels WHERE id = $1', [id]);
    return rows[0] ?? null;
  },
  async list(owner: { projectId?: string; userId?: string }): Promise<NotificationChannel[]> {
    const { rows } = owner.projectId
      ? await pool.query<Row>('SELECT * FROM notification_channels WHERE project_id = $1 ORDER BY created_at', [owner.projectId])
      : await pool.query<Row>('SELECT * FROM notification_channels WHERE user_id = $1 ORDER BY created_at', [owner.userId]);
    return rows.map(toChannel);
  },
  /** Canaux actifs qui relaient cette notification (famille `category`). */
  async matching(n: Notification, category: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id FROM notification_channels c
        WHERE c.enabled AND $1 = ANY(c.categories)
          AND (
            -- Canal de projet : notifications adressées à tous les membres du projet.
            (c.project_id IS NOT NULL AND $2::uuid IS NOT NULL AND c.project_id = $2 AND $3::uuid IS NULL AND NOT $4::boolean)
            OR
            -- Canal personnel : ce que la personne voit dans sa cloche.
            (c.user_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM users u WHERE u.id = c.user_id AND (
                ($3::uuid IS NOT NULL AND u.id = $3)
                OR ($3::uuid IS NULL AND (NOT $4::boolean OR u.is_admin)
                    AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $2 AND m.user_id = u.id)))
              )))
          )`,
      [category, n.projectId, n.userId, n.adminsOnly],
    );
    return rows.map((r) => r.id);
  },
  async recordResult(id: string, error: string | null): Promise<void> {
    if (error) await pool.query('UPDATE notification_channels SET last_error = $2 WHERE id = $1', [id, error.slice(0, 500)]);
    else await pool.query('UPDATE notification_channels SET last_sent_at = now(), last_error = NULL WHERE id = $1', [id]);
  },
};

async function sendBatch(channelId: string, items: OutgoingItem[]): Promise<void> {
  const row = await notificationChannelRepository.findById(channelId);
  if (!row || !row.enabled) return;
  try {
    await deliver(row.kind, decryptSecret(row.target), items);
    await notificationChannelRepository.recordResult(channelId, null);
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`[notifications] canal ${row.kind} ${row.id} : envoi impossible (${message})`);
    await notificationChannelRepository.recordResult(channelId, message).catch(() => undefined);
  }
}

const batcher = createBatcher<OutgoingItem>({ windowMs: BATCH_WINDOW_MS, send: sendBatch });

async function projectName(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [projectId]);
  return rows[0]?.name ?? null;
}

export const notificationChannelService = {
  list: (owner: { projectId?: string; userId?: string }) => notificationChannelRepository.list(owner),

  async get(id: string): Promise<NotificationChannel> {
    const row = await notificationChannelRepository.findById(id);
    if (!row) throw new NotFoundError('Canal de notification introuvable');
    return toChannel(row);
  },

  async create(owner: { projectId: string | null; userId: string | null; admin: boolean }, input: ChannelInput, createdById: string): Promise<NotificationChannel> {
    if (!CHANNEL_KINDS.includes(input.kind as ChannelKind)) throw new AppError(`Type de canal inconnu : ${input.kind}`);
    const kind = input.kind as ChannelKind;
    const { target, hint } = validateTarget(kind, input.target);
    const categories = normalizeCategories(input.categories, allowedCategories(owner));
    const { rows } = await pool.query<Row>(
      `INSERT INTO notification_channels (project_id, user_id, kind, target, target_hint, categories, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [owner.projectId, owner.projectId ? null : owner.userId, kind, encryptSecret(target), hint, categories, createdById],
    );
    return toChannel(rows[0]);
  },

  async update(id: string, admin: boolean, patch: ChannelPatch): Promise<NotificationChannel> {
    const row = await notificationChannelRepository.findById(id);
    if (!row) throw new NotFoundError('Canal de notification introuvable');
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (patch.target != null && patch.target.trim()) {
      const { target, hint } = validateTarget(row.kind, patch.target);
      sets.push(`target = $${params.push(encryptSecret(target))}`, `target_hint = $${params.push(hint)}`, 'last_error = NULL');
    }
    if (patch.categories != null) sets.push(`categories = $${params.push(normalizeCategories(patch.categories, allowedCategories({ projectId: row.project_id, admin })))}`);
    if (patch.enabled != null) sets.push(`enabled = $${params.push(Boolean(patch.enabled))}`);
    if (!sets.length) return toChannel(row);
    const { rows } = await pool.query<Row>(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return toChannel(rows[0]);
  },

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM notification_channels WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  },

  /** Message de test, envoyé aussitôt (sans regroupement) ; lève avec la raison de l'échec. */
  async test(id: string): Promise<NotificationChannel> {
    const row = await notificationChannelRepository.findById(id);
    if (!row) throw new NotFoundError('Canal de notification introuvable');
    const item: OutgoingItem = { title: 'Skipper : canal de notification opérationnel', message: 'Les notifications choisies arriveront ici, avec un lien vers la page concernée.', url: absoluteLink('/'), projectName: await projectName(row.project_id) };
    try {
      await deliver(row.kind, decryptSecret(row.target), [item]);
      await notificationChannelRepository.recordResult(id, null);
    } catch (err) {
      await notificationChannelRepository.recordResult(id, (err as Error).message);
      throw new AppError(`Envoi impossible : ${(err as Error).message}`);
    }
    return this.get(id);
  },

  /** Relaie une notification aux canaux concernés (appelé par notificationService.notify). Ne lève jamais. */
  async relay(n: Notification): Promise<void> {
    try {
      const category = categoryOf(n.type);
      if (!category) return;
      const ids = await notificationChannelRepository.matching(n, category);
      if (!ids.length) return;
      const item: OutgoingItem = { title: n.title, message: n.message, url: absoluteLink(n.link), projectName: await projectName(n.projectId) };
      const urgent = n.type === 'request.created';
      for (const id of ids) batcher.push(id, item, urgent);
    } catch (err) {
      log.error('[notifications] relais vers les canaux impossible', err);
    }
  },

  /** Envoie ce que l'anti-rafale retient encore (arrêt du serveur). */
  flush: () => batcher.flushAll(),
};
