import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { googleAccountService } from './service.js';

/** Client Gmail minimal (API REST v1) au nom d'un compte Google relié à un projet. */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 60_000;

interface Header {
  name: string;
  value: string;
}
interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
}
interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
}

/** Pièce jointe telle que listée à l'agent : numérotée à partir de 1 pour la désigner à gmail_attachment. */
export interface AttachmentInfo {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
}

/** Pièce jointe avec de quoi récupérer son contenu : identifiant Gmail (partie séparée) ou données en ligne. */
interface AttachmentPart extends AttachmentInfo {
  attachmentId?: string;
  data?: string;
}

export interface MessageContent extends MessageSummary {
  cc: string;
  messageId: string;
  body: string;
  bodyTruncated: boolean;
  attachments: AttachmentInfo[];
}

const header = (headers: Header[] | undefined, name: string): string => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const decodeBody = (data?: string): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Entités HTML nommées les plus fréquentes dans les mails (les autres passent par les formes numériques). */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€', copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', middot: '·', bull: '•',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', Agrave: 'À', Acirc: 'Â', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', Egrave: 'È', Eacute: 'É',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', oelig: 'œ', OElig: 'Œ', aelig: 'æ', szlig: 'ß',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

/** Texte lisible d'un HTML : balises retirées, entités décodées, espaces resserrés. */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/h[1-6]>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parcourt les parties MIME : texte brut de préférence, sinon HTML converti ; pièces jointes listées (parties
 * nommées, qu'elles soient stockées à part par Gmail ou incluses en ligne quand elles sont petites).
 */
function extract(payload: Part | undefined): { text: string; html: string; attachments: AttachmentPart[] } {
  const out = { text: '', html: '', attachments: [] as AttachmentPart[] };
  const walk = (p: Part | undefined) => {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.data)) {
      out.attachments.push({
        index: out.attachments.length + 1,
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body.size ?? 0,
        attachmentId: p.body.attachmentId,
        data: p.body.attachmentId ? undefined : p.body.data,
      });
    } else if (p.mimeType === 'text/plain' && p.body?.data) {
      out.text += decodeBody(p.body.data);
    } else if (p.mimeType === 'text/html' && p.body?.data) {
      out.html += decodeBody(p.body.data);
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

function toSummary(m: Message): MessageSummary {
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    date: header(h, 'Date') || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ''),
    from: header(h, 'From'),
    to: header(h, 'To'),
    subject: header(h, 'Subject'),
    snippet: m.snippet ?? '',
    labels: m.labelIds ?? [],
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

export async function search(accountId: string, query: string, maxResults: number): Promise<{ messages: MessageSummary[]; estimate: number }> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const list = await googleAccountService.json<{ messages?: Array<{ id: string }>; resultSizeEstimate?: number }>(accountId, `${BASE}/messages?${params}`);
  const ids = list.messages ?? [];
  const messages = await Promise.all(
    ids.map((m) =>
      googleAccountService.json<Message>(accountId, `${BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`),
    ),
  );
  return { messages: messages.map(toSummary), estimate: list.resultSizeEstimate ?? ids.length };
}

export async function read(accountId: string, messageId: string): Promise<MessageContent> {
  const [m, labels] = await Promise.all([
    googleAccountService.json<Message>(accountId, `${BASE}/messages/${encodeURIComponent(messageId)}?format=full`),
    // Pour afficher les libellés personnels par leur nom ; sans eux, les identifiants bruts.
    listLabels(accountId).catch(() => [] as Label[]),
  ]);
  const { text, html, attachments } = extract(m.payload);
  const full = (text.trim() || htmlToText(html)).trim();
  const summary = toSummary(m);
  return {
    ...summary,
    labels: labelNames(summary.labels, labels),
    cc: header(m.payload?.headers, 'Cc'),
    messageId: header(m.payload?.headers, 'Message-ID'),
    body: full.slice(0, MAX_BODY_CHARS),
    bodyTruncated: full.length > MAX_BODY_CHARS,
    attachments: attachments.map(({ index, filename, mimeType, size }) => ({ index, filename, mimeType, size })),
  };
}

/** Nom de fichier sûr pour le disque : sans chemin ni caractère de contrôle, jamais vide. */
function safeFilename(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '');
  return base || 'piece-jointe';
}

/**
 * Télécharge une pièce jointe d'un message dans le dossier de travail. `which` la désigne par son numéro dans la
 * liste de `read` (à partir de 1) ou par son nom de fichier ; `resolveTarget` reçoit le nom de fichier sûr et
 * renvoie le chemin local (déjà contrôlé) où écrire.
 */
export async function downloadAttachment(
  accountId: string,
  messageId: string,
  which: string,
  resolveTarget: (filename: string) => string,
): Promise<{ filename: string; mimeType: string; bytes: number; localPath: string }> {
  const m = await googleAccountService.json<Message>(accountId, `${BASE}/messages/${encodeURIComponent(messageId)}?format=full`);
  const { attachments } = extract(m.payload);
  if (!attachments.length) throw new AppError('Ce message n\'a pas de pièce jointe');
  const wanted = which.trim();
  const describe = () => attachments.map((a) => `${a.index}. ${a.filename}`).join(' ; ');
  let part: AttachmentPart | undefined;
  if (/^\d+$/.test(wanted)) {
    part = attachments.find((a) => a.index === Number(wanted));
    if (!part) throw new AppError(`Pas de pièce jointe numéro ${wanted} (pièces jointes : ${describe()})`);
  } else {
    const matches = attachments.filter((a) => a.filename.toLowerCase() === wanted.toLowerCase());
    if (!matches.length) throw new AppError(`Pas de pièce jointe nommée « ${wanted} » (pièces jointes : ${describe()})`);
    if (matches.length > 1) throw new AppError(`Plusieurs pièces jointes s'appellent « ${wanted} » : désigne-la par son numéro (${describe()})`);
    part = matches[0];
  }
  let data = part.data;
  if (part.attachmentId) {
    const body = await googleAccountService.json<{ size?: number; data?: string }>(
      accountId,
      `${BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.attachmentId)}`,
    );
    data = body.data;
  }
  if (!data) throw new AppError(`Contenu de « ${part.filename} » indisponible`);
  const bytes = Buffer.from(data, 'base64url');
  const localPath = resolveTarget(safeFilename(part.filename));
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes);
  return { filename: part.filename, mimeType: part.mimeType, bytes: bytes.length, localPath };
}

export interface SendInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Répondre à ce message : même fil, en-têtes In-Reply-To / References, destinataire et sujet déduits si absents. */
  replyToMessageId?: string;
}

/** Encodage RFC 2047 d'un en-tête non ASCII. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

/** Message MIME prêt pour l'API (raw en base64url) ; pour une réponse, le fil et les en-têtes de suivi du message d'origine. */
async function compose(accountId: string, input: SendInput, draft: boolean): Promise<{ raw: string; threadId?: string; to: string; subject: string }> {
  let to = input.to.trim();
  let subject = input.subject.trim();
  let threadId: string | undefined;
  const extraHeaders: string[] = [];
  if (input.replyToMessageId) {
    const original = await googleAccountService.json<Message>(
      accountId,
      `${BASE}/messages/${encodeURIComponent(input.replyToMessageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`,
    );
    const h = original.payload?.headers;
    threadId = original.threadId;
    if (!to) to = header(h, 'Reply-To') || header(h, 'From');
    if (!subject) {
      const s = header(h, 'Subject');
      subject = /^re\s*:/i.test(s) ? s : `Re: ${s}`;
    }
    const msgId = header(h, 'Message-ID');
    if (msgId) {
      extraHeaders.push(`In-Reply-To: ${msgId}`);
      extraHeaders.push(`References: ${[header(h, 'References'), msgId].filter(Boolean).join(' ')}`);
    }
  }
  // Un brouillon peut rester incomplet (destinataire ou sujet à remplir plus tard) ; un envoi, non.
  if (!draft && !to) throw new AppError('Destinataire obligatoire');
  if (!draft && !subject) throw new AppError('Sujet obligatoire');
  const headers = [
    to ? `To: ${to}` : '',
    input.cc?.trim() ? `Cc: ${input.cc.trim()}` : '',
    input.bcc?.trim() ? `Bcc: ${input.bcc.trim()}` : '',
    `Subject: ${encodeHeader(subject)}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const mime = `${headers.join('\r\n')}\r\n\r\n${Buffer.from(input.body, 'utf8').toString('base64')}`;
  return { raw: Buffer.from(mime, 'utf8').toString('base64url'), threadId, to, subject };
}

export async function send(accountId: string, input: SendInput): Promise<{ id: string; threadId: string; to: string; subject: string }> {
  const { raw, threadId, to, subject } = await compose(accountId, input, false);
  const sent = await googleAccountService.json<{ id: string; threadId: string }>(accountId, `${BASE}/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  return { id: sent.id, threadId: sent.threadId, to, subject };
}

export interface DraftSummary extends MessageSummary {
  draftId: string;
}

/** Brouillons du compte, les plus récents d'abord. */
export async function listDrafts(accountId: string, maxResults: number): Promise<DraftSummary[]> {
  const list = await googleAccountService.json<{ drafts?: Array<{ id: string }> }>(accountId, `${BASE}/drafts?maxResults=${maxResults}`);
  const drafts = await Promise.all(
    (list.drafts ?? []).map((d) => googleAccountService.json<{ id: string; message: Message }>(accountId, `${BASE}/drafts/${encodeURIComponent(d.id)}?format=metadata`)),
  );
  return drafts.map((d) => ({ ...toSummary(d.message), draftId: d.id }));
}

/**
 * Crée un brouillon, ou remplace entièrement le contenu d'un brouillon existant (`draftId`). Une réponse
 * (`replyToMessageId`) est rangée dans le fil du message d'origine, comme gmail_send.
 */
export async function saveDraft(accountId: string, input: SendInput & { draftId?: string }): Promise<{ draftId: string; messageId: string; threadId: string; to: string; subject: string; replaced: boolean }> {
  const { raw, threadId, to, subject } = await compose(accountId, input, true);
  const message = threadId ? { raw, threadId } : { raw };
  const draftId = input.draftId?.trim();
  const saved = await googleAccountService.json<{ id: string; message: { id: string; threadId: string } }>(
    accountId,
    draftId ? `${BASE}/drafts/${encodeURIComponent(draftId)}` : `${BASE}/drafts`,
    {
      method: draftId ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draftId ? { id: draftId, message } : { message }),
    },
  );
  return { draftId: saved.id, messageId: saved.message.id, threadId: saved.message.threadId, to, subject, replaced: Boolean(draftId) };
}

/** Supprime définitivement un brouillon (les brouillons ne passent pas par la corbeille). */
export async function deleteDraft(accountId: string, draftId: string): Promise<void> {
  await googleAccountService.raw(accountId, `${BASE}/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
}

/** Place un message dans la corbeille (récupérable 30 jours dans Gmail, puis supprimé). */
export async function trash(accountId: string, messageId: string): Promise<MessageSummary> {
  await googleAccountService.json<Message>(accountId, `${BASE}/messages/${encodeURIComponent(messageId)}/trash`, { method: 'POST' });
  const m = await googleAccountService.json<Message>(
    accountId,
    `${BASE}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
  );
  return toSummary(m);
}

export interface Label {
  id: string;
  name: string;
  /** `system` (INBOX, UNREAD, STARRED…, nom = identifiant) ou `user`. */
  type: string;
}

/** Libellés du compte : ceux de Gmail puis ceux créés par la personne, par ordre alphabétique. */
export async function listLabels(accountId: string): Promise<Label[]> {
  const r = await googleAccountService.json<{ labels?: Label[] }>(accountId, `${BASE}/labels`);
  const labels = (r.labels ?? []).map(({ id, name, type }) => ({ id, name, type }));
  return labels.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'fr') : a.type === 'system' ? -1 : 1));
}

/** Noms lisibles des libellés d'un message (les libellés personnels ont des identifiants opaques, Label_123). */
const labelNames = (ids: string[], labels: Label[]) => ids.map((id) => labels.find((l) => l.id === id)?.name ?? id);

/**
 * Identifiants Gmail des libellés désignés par leur nom (insensible à la casse, « Parent/Enfant » pour un
 * sous-libellé) ou leur identifiant. Un libellé à ajouter qui n'existe pas encore est créé ; un libellé à
 * retirer qui n'existe pas est une erreur (faute de frappe probable).
 */
async function resolveLabels(accountId: string, labels: Label[], wanted: string[], create: boolean): Promise<{ ids: string[]; created: string[] }> {
  const ids: string[] = [];
  const created: string[] = [];
  for (const raw of wanted) {
    const w = raw.trim();
    if (!w) continue;
    const found = labels.find((l) => l.id === w) ?? labels.find((l) => l.name.toLowerCase() === w.toLowerCase());
    if (found) {
      ids.push(found.id);
      continue;
    }
    if (!create) throw new AppError(`Libellé inconnu : « ${w} » (gmail_labels pour la liste)`);
    const label = await googleAccountService.json<Label>(accountId, `${BASE}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: w, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    });
    labels.push({ id: label.id, name: label.name, type: 'user' });
    ids.push(label.id);
    created.push(label.name);
  }
  return { ids, created };
}

export interface ModifyInput {
  /** Archiver (retirer de la boîte de réception) ou, à false, remettre dans la boîte de réception. */
  archive?: boolean;
  /** Marquer comme lu, ou à false comme non lu. */
  read?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
  /** Appliquer au fil entier de chaque message, comme l'interface de Gmail (défaut), ou au seul message. */
  wholeThread?: boolean;
}

export interface ModifyResult {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  /** Libellés après modification (noms lisibles). */
  labels: string[];
  ok: boolean;
  error?: string;
}

/**
 * Archive, remet dans la boîte de réception, marque lu ou non lu, ajoute ou retire des libellés sur des
 * messages (ou leurs fils). Les libellés à ajouter qui n'existent pas sont créés. Chaque fil n'est modifié
 * qu'une fois même si plusieurs de ses messages sont désignés ; un échec sur un message n'arrête pas les autres.
 */
export async function modify(accountId: string, messageIds: string[], input: ModifyInput): Promise<{ results: ModifyResult[]; created: string[] }> {
  const labels = await listLabels(accountId);
  const add = await resolveLabels(accountId, labels, input.addLabels ?? [], true);
  const remove = await resolveLabels(accountId, labels, input.removeLabels ?? [], false);
  const addIds = new Set(add.ids);
  const removeIds = new Set(remove.ids);
  if (input.archive === true) removeIds.add('INBOX');
  if (input.archive === false) addIds.add('INBOX');
  if (input.read === true) removeIds.add('UNREAD');
  if (input.read === false) addIds.add('UNREAD');
  const conflict = [...addIds].filter((id) => removeIds.has(id));
  if (conflict.length) throw new AppError(`Libellé à la fois ajouté et retiré : ${labelNames(conflict, labels).join(', ')}`);
  if (!addIds.size && !removeIds.size) throw new AppError('Rien à modifier : indique archive, read, add_labels ou remove_labels');
  const body = JSON.stringify({ addLabelIds: [...addIds], removeLabelIds: [...removeIds] });
  const wholeThread = input.wholeThread !== false;
  const doneThreads = new Set<string>();
  const results: ModifyResult[] = [];
  for (const id of messageIds) {
    try {
      const m = await googleAccountService.json<Message>(accountId, `${BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const base = { id: m.id, threadId: m.threadId, subject: header(m.payload?.headers, 'Subject'), from: header(m.payload?.headers, 'From') };
      if (wholeThread && doneThreads.has(m.threadId)) continue;
      let after: string[];
      if (wholeThread) {
        const t = await googleAccountService.json<{ messages?: Message[] }>(accountId, `${BASE}/threads/${encodeURIComponent(m.threadId)}/modify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        doneThreads.add(m.threadId);
        after = t.messages?.find((x) => x.id === m.id)?.labelIds ?? t.messages?.at(-1)?.labelIds ?? [];
      } else {
        const r = await googleAccountService.json<Message>(accountId, `${BASE}/messages/${encodeURIComponent(id)}/modify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        after = r.labelIds ?? [];
      }
      results.push({ ...base, labels: labelNames(after, labels), ok: true });
    } catch (err) {
      results.push({ id, threadId: '', subject: '', from: '', labels: [], ok: false, error: (err as Error).message });
    }
  }
  return { results, created: add.created };
}

export function renderLabels(labels: Label[]): string {
  if (labels.length === 0) return 'Aucun libellé.';
  const system = labels.filter((l) => l.type === 'system').map((l) => l.name);
  const user = labels.filter((l) => l.type !== 'system').map((l) => `- ${l.name}`);
  return [`Libellés de Gmail : ${system.join(', ')}`, user.length ? `Libellés personnels (${user.length}) :\n${user.join('\n')}` : 'Aucun libellé personnel.'].join('\n');
}

export function renderDrafts(drafts: DraftSummary[]): string {
  if (drafts.length === 0) return 'Aucun brouillon.';
  const lines = drafts.map((d) => `- [brouillon ${d.draftId}, message ${d.id}] ${d.date} · à ${d.to || '(personne)'} · ${d.subject || '(sans sujet)'}\n  ${d.snippet}`);
  return [`${drafts.length} brouillon(s) (gmail_read avec l'identifiant du message pour le corps) :`, ...lines].join('\n');
}

export function renderSummaries(result: { messages: MessageSummary[]; estimate: number }): string {
  if (result.messages.length === 0) return 'Aucun message ne correspond.';
  const lines = result.messages.map((m) => `- [${m.id}] ${m.date} · de ${m.from || '?'} · ${m.subject || '(sans sujet)'}${m.unread ? ' · non lu' : ''}\n  ${m.snippet}`);
  return [`${result.messages.length} message(s) affiché(s)${result.estimate > result.messages.length ? ` sur environ ${result.estimate}` : ''} :`, ...lines].join('\n');
}

export function renderMessage(m: MessageContent): string {
  const head = [
    `Id : ${m.id} (fil ${m.threadId})`,
    `Date : ${m.date}`,
    `De : ${m.from}`,
    `À : ${m.to}`,
    m.cc ? `Cc : ${m.cc}` : '',
    `Sujet : ${m.subject}`,
    m.labels.length ? `Libellés : ${m.labels.join(', ')}` : '',
    m.attachments.length ? `Pièces jointes (gmail_attachment pour en télécharger une) : ${m.attachments.map((a) => `${a.index}. ${a.filename} (${a.mimeType}, ${a.size} octets)`).join(' ; ')}` : '',
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${m.body || '(corps vide)'}${m.bodyTruncated ? '\n\n[corps tronqué]' : ''}`;
}
