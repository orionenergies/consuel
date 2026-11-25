import { promises as dns } from 'node:dns';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from './config';

const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice(7);
    return net.isIPv4(mapped) ? isPrivateIPv4(mapped) : true;
  }
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Empêche le bot d'être utilisé pour atteindre le réseau interne ou le serveur de métadonnées GCP. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Protocole non autorisé pour le DRE : ${url.protocol}`);
  }
  // Réservé aux tests automatisés (serveur de test sur localhost).
  if (process.env.ALLOW_PRIVATE_DRE_URLS === 'true') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });
  for (const { address } of addresses) {
    const priv = net.isIPv4(address) ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (priv) throw new Error(`URL du DRE refusée (adresse non publique : ${host})`);
  }
  return url;
}

function fileNameFrom(url: URL, contentDisposition: string | null, contentType: string | null): string {
  const cd = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  let name = cd ? decodeURIComponent(cd) : decodeURIComponent(path.basename(url.pathname));
  name = name.replace(/[^\w.\- ()]/g, '_').trim();
  if (!name || name === '_') name = 'dre';
  if (!path.extname(name)) {
    const ext = contentType?.includes('pdf')
      ? '.pdf'
      : contentType?.includes('png')
        ? '.png'
        : contentType?.includes('jpeg')
          ? '.jpg'
          : '.pdf';
    name += ext;
  }
  return name;
}

export interface DownloadedFile {
  filePath: string;
  fileName: string;
  bytes: number;
  cleanup: () => Promise<void>;
}

export async function downloadDre(rawUrl: string): Promise<DownloadedFile> {
  let url = await assertPublicUrl(rawUrl);
  let res: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) {
    throw new Error(`Téléchargement du DRE impossible (HTTP ${res?.status ?? '?'})`);
  }

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > config.dreMaxBytes) {
    throw new Error(`DRE trop volumineux (${declared} octets)`);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'dre-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fileName = fileNameFrom(url, res.headers.get('content-disposition'), res.headers.get('content-type'));
  const filePath = path.join(dir, fileName);

  let bytes = 0;
  const limiter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > config.dreMaxBytes) throw new Error('DRE trop volumineux');
      yield chunk;
    }
  };

  try {
    await pipeline(Readable.fromWeb(res.body as never), limiter, createWriteStream(filePath));
    if (bytes === 0) throw new Error('Le DRE téléchargé est vide');
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { filePath, fileName, bytes, cleanup };
}
