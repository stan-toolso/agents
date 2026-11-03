import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { decodeAttachments, MAX_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, normalizeMediaType } from '../sessions/attachments.js';
import type { AttachmentInput } from '../sessions/types.js';
import { describeAttachment, fitInInstruction, shownToAgent, type McpContent } from '../tasks/attachments.js';
import { conversationRepository } from './repository.js';
import type { MessageAttachment } from './types.js';

/**
 * Fichiers joints aux messages des canaux (captures collées, documents) : vérifiés comme ceux d'une instruction
 * (nombre, tailles), le contenu sur le disque du serveur par canal, les métadonnées dans `message_attachments`.
 * Mêmes règles que les fichiers du fil des tâches (tasks/attachments.ts), dont les fonctions pures sont reprises.
 */

/** Dossier des fichiers joints aux messages, à part des projets. */
export const messageAttachmentsRoot = (): string => path.join(config.workspacesRoot, '.message-attachments');
const conversationDir = (conversationId: string) => path.join(messageAttachmentsRoot(), conversationId);
const attachmentDir = (conversationId: string, id: string) => path.join(conversationDir(conversationId), id);

/** Chemin du fichier d'une pièce jointe (le nom est déjà assaini à l'enregistrement). */
export const messageAttachmentPath = (a: Pick<MessageAttachment, 'conversationId' | 'id' | 'name'>): string => path.join(attachmentDir(a.conversationId, a.id), a.name);

/** Vérifie un lot de fichiers avant toute écriture (nombre en comptant ceux restant sur le message, tailles, encodage). */
export async function validateMessageAttachments(messageId: string | null, inputs: AttachmentInput[] | null | undefined, removedIds: string[] | null | undefined = null): Promise<void> {
  if (!inputs?.length) return;
  const existing = messageId ? (await conversationRepository.listAttachments([messageId])).filter((a) => !removedIds?.includes(a.id)) : [];
  if (existing.length + inputs.length > MAX_ATTACHMENTS) throw new AppError(`Au plus ${MAX_ATTACHMENTS} fichiers par message`);
  decodeAttachments(inputs, 'message');
}

/** Vérifie, enregistre et inscrit les fichiers d'un message. Tout ou rien : en cas d'échec, ce qui a été écrit est retiré. */
export async function storeMessageAttachments(conversationId: string, messageId: string, inputs: AttachmentInput[] | null | undefined): Promise<MessageAttachment[]> {
  if (!inputs?.length) return [];
  await validateMessageAttachments(messageId, inputs);
  const stored: MessageAttachment[] = [];
  let pending: string | null = null;
  try {
    for (const { input, name, bytes } of decodeAttachments(inputs, 'message')) {
      const id = randomUUID();
      pending = id;
      await mkdir(attachmentDir(conversationId, id), { recursive: true });
      await writeFile(path.join(attachmentDir(conversationId, id), name), bytes);
      stored.push(await conversationRepository.createAttachment({ id, conversationId, messageId, name, mediaType: normalizeMediaType(input.mediaType, name), size: bytes.length }));
      pending = null;
    }
  } catch (err) {
    for (const id of [...stored.map((a) => a.id), ...(pending ? [pending] : [])]) {
      await conversationRepository.deleteAttachment(id).catch(() => undefined);
      await rm(attachmentDir(conversationId, id), { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
  return stored;
}

/** Retire des fichiers d'un message : lignes et fichiers. Les identifiants inconnus (ou d'un autre message) sont ignorés. */
export async function removeMessageAttachments(messageId: string, ids: string[] | null | undefined): Promise<MessageAttachment[]> {
  if (!ids?.length) return [];
  const removable = (await conversationRepository.listAttachments([messageId])).filter((a) => ids.includes(a.id));
  for (const a of removable) {
    await conversationRepository.deleteAttachment(a.id);
    await rm(attachmentDir(a.conversationId, a.id), { recursive: true, force: true });
  }
  return removable;
}

/** Retire les fichiers de pièces jointes déjà effacées en base (message supprimé : ses lignes partent en cascade). */
export async function removeMessageAttachmentFiles(attachments: MessageAttachment[]): Promise<void> {
  for (const a of attachments) await rm(attachmentDir(a.conversationId, a.id), { recursive: true, force: true }).catch(() => undefined);
}

/** Fichier d'une pièce jointe (route de téléchargement), ou null s'il a disparu. */
export async function messageAttachmentFile(a: MessageAttachment): Promise<{ path: string; size: number } | null> {
  try {
    const info = await stat(messageAttachmentPath(a));
    return info.isFile() ? { path: messageAttachmentPath(a), size: info.size } : null;
  } catch {
    return null;
  }
}

const readBytes = (a: MessageAttachment): Promise<Buffer | null> => readFile(messageAttachmentPath(a)).catch(() => null);

/** Les fichiers d'un message comme fichiers d'une instruction (base64), autant qu'une instruction en porte : la session à qui le message est adressé les reçoit. */
export async function messageAttachmentsAsInstruction(attachments: MessageAttachment[]): Promise<AttachmentInput[]> {
  const out: AttachmentInput[] = [];
  for (const a of fitInInstruction(attachments).kept) {
    const bytes = await readBytes(a);
    if (bytes) out.push({ name: a.name, mediaType: a.mediaType, data: bytes.toString('base64') });
  }
  return out;
}

/** Au plus, par réponse de `conversations.read` : nombre d'images montrées et leur poids total (la réponse d'un outil reste raisonnable). */
export const MAX_SHOWN_IMAGES = 10;
export const MAX_SHOWN_IMAGE_BYTES = MAX_TOTAL_ATTACHMENT_BYTES;

/** Les images montrées à l'agent (blocs image) parmi des fichiers, dans l'ordre, dans les limites d'une réponse d'outil. Pur. */
export function pickShownImages<T extends Pick<MessageAttachment, 'mediaType' | 'size'>>(attachments: T[], maxCount = MAX_SHOWN_IMAGES, maxBytes = MAX_SHOWN_IMAGE_BYTES): T[] {
  const shown: T[] = [];
  let total = 0;
  for (const a of attachments) {
    if (shown.length >= maxCount) break;
    if (!shownToAgent(a) || total + a.size > maxBytes) continue;
    shown.push(a);
    total += a.size;
  }
  return shown;
}

/** Des images en blocs image d'une réponse d'outil MCP (`conversations.read`) : l'agent voit les captures. Un fichier disparu est ignoré. */
export async function messageImageBlocks(images: MessageAttachment[]): Promise<McpContent[]> {
  const blocks: McpContent[] = [];
  for (const a of images) {
    const bytes = await readBytes(a);
    if (bytes) blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: a.mediaType });
  }
  return blocks;
}

/**
 * Comment les fichiers d'un message parviennent à l'agent : joints à l'instruction qui le transmet (`instruction`),
 * montrés en blocs image par l'outil pour ceux de `shown` (`tool`), ou seulement nommés.
 */
export type MessageFilesDelivery = { kind: 'instruction'; ids: Set<string> } | { kind: 'tool'; shown: Set<string> } | { kind: 'none' };

/** Bloc « Fichiers joints : » d'un message, une ligne par fichier ; rien sans fichier. */
export function describeMessageAttachments(attachments: Pick<MessageAttachment, 'id' | 'name' | 'mediaType' | 'size'>[], delivery: MessageFilesDelivery = { kind: 'none' }): string[] {
  if (!attachments.length) return [];
  const note = (a: Pick<MessageAttachment, 'id'>) => {
    if (delivery.kind === 'instruction' && delivery.ids.has(a.id)) return ' — joint à cette instruction';
    if (delivery.kind === 'tool' && delivery.shown.has(a.id)) return ' — montré ci-dessous';
    return '';
  };
  return ['Fichiers joints :', ...attachments.map((a) => `- ${describeAttachment(a)}${note(a)}`)];
}
