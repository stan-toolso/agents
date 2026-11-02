import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Archives tar.gz minimales (format ustar, fichiers ordinaires seulement) pour l'export et l'import d'un projet,
 * sans dépendance. Les noms longs passent par l'en-tête étendu PAX (`path`), que lisent tar, 7-Zip et l'explorateur
 * de fichiers de macOS ou de Windows ; la lecture accepte ces en-têtes (et les noms longs GNU) et ignore tout ce qui
 * n'est pas un fichier.
 */

export interface TarEntry {
  name: string;
  content: Buffer;
}

const BLOCK = 512;
/** Taille décompressée maximale acceptée à la lecture : une archive d'import n'a rien à faire au-delà. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | 'x', mtime: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(0o644, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');
  buf.write(octal(0, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(mtime, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(type, 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return buf;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Enregistrement PAX `<longueur> path=<nom>\n`, la longueur se comptant elle-même. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`, 'utf8');
}

export function packTarGz(entries: TarEntry[], mtime: Date = new Date()): Buffer {
  const seconds = Math.floor(mtime.getTime() / 1000);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    // Nom tronqué dans l'en-tête ustar (100 octets) : le vrai nom va dans un en-tête PAX qui le précède.
    if (Buffer.byteLength(entry.name) > 100 || /[^\x20-\x7e]/.test(entry.name)) {
      const pax = paxRecord('path', entry.name);
      parts.push(header('PaxHeader', pax.length, 'x', seconds), pax, padding(pax.length));
    }
    const short = Buffer.from(entry.name, 'utf8').subarray(0, 100).toString('utf8').replace(/�+$/, '');
    parts.push(header(short, entry.content.length, '0', seconds), entry.content, padding(entry.content.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/** Fichiers d'une archive tar.gz (ou tar non compressée). Lève une erreur si elle est illisible ou trop grosse. */
export function unpackTarGz(archive: Buffer): TarEntry[] {
  const gzipped = archive[0] === 0x1f && archive[1] === 0x8b;
  const tar = gzipped ? gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }) : archive;
  const entries: TarEntry[] = [];
  let offset = 0;
  let pending: Record<string, string> = {};
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) break;
    if (readString(block, 257, 6) !== 'ustar' && readString(block, 257, 5) !== 'ustar') throw new Error('Archive tar invalide');
    const size = parseInt(readString(block, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Archive tar invalide');
    const type = String.fromCharCode(block[156] || 0x30);
    const prefix = readString(block, 345, 155);
    const name = prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length < size) throw new Error('Archive tar tronquée');
    offset = dataStart + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === 'x') {
      pending = parsePax(data);
      continue;
    }
    // Nom long au format GNU (tar de GNU par défaut) : le contenu de l'en-tête est le nom de l'entrée suivante.
    if (type === 'L') {
      pending = { ...pending, path: readString(data, 0, data.length) };
      continue;
    }
    if (type === 'g' || type === 'K') continue;
    if (type === '0' || type === '\0' || type === '7') entries.push({ name: pending.path ?? name, content: Buffer.from(data) });
    pending = {};
  }
  return entries;
}
