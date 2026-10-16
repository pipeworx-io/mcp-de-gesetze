/**
 * Gesetze im Internet (BMJ / juris) — ZIP + XML parsing.
 *
 * Each law/ordinance ships as a per-law ZIP containing exactly one XML file
 * (DTD gii-norm.dtd): a flat sequence of <norm> elements. The norm whose
 * doknr equals the <dokumente> wrapper's own doknr carries the LAW'S front
 * matter (jurabk, amtabk, ausfertigung-datum, fundstelle, standangabe...).
 * Every other <norm> is either a structural heading (<gliederungseinheit>,
 * e.g. "Buch 1 / Allgemeiner Teil") or an actual provision (<enbez>, e.g.
 * "§ 1" or "Art 1") with its own <titel>, a <textdaten>/<text>/<Content>
 * body, and an optional <fussnoten> block (amendment/application notes).
 *
 * Workers-runtime ZIP reading: central-directory walk + the native
 * DecompressionStream('deflate-raw') — no dependency, the same approach
 * mcps/ca-dmv/src/xlsx.ts and mcps/georgia-energy/src/xlsx.ts use for XLSX's
 * own ZIP container (XLSX is a ZIP of XML parts too).
 */

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const stream = src.pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

/** Find the single .xml entry in a GiI law package ZIP and return its decoded text. */
export async function extractLawXml(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('gii package: no ZIP End Of Central Directory record found — not a valid ZIP.');
  const total = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);

  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const fnLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOffset = dv.getUint32(cd + 42, true);
    const name = dec.decode(bytes.subarray(cd + 46, cd + 46 + fnLen));
    cd += 46 + fnLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith('.xml')) continue;
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lFnLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lFnLen + lExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) return dec.decode(payload);
    if (method === 8) return dec.decode(await inflateRaw(payload));
    throw new Error(`gii package: unsupported ZIP compression method ${method} for ${name}.`);
  }
  throw new Error('gii package: ZIP contains no .xml entry.');
}

// ── XML field extraction ────────────────────────────────────────────────

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** Raw (undecoded, tags intact) first match of <tag ...>...</tag> within block. */
function rawTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

/** All raw matches of <tag ...>...</tag> within block. */
function rawTagAll(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

/** A leaf field: strip any nested tags, decode entities, trim. null if absent/empty. */
function leaf(block: string, tag: string): string | null {
  const raw = rawTag(block, tag);
  if (raw == null) return null;
  const text = decodeXmlEntities(raw.replace(/<[^>]+>/g, '')).trim();
  return text || null;
}

/** Flatten a GiI <Content> body (P/DL/DT/DD/LA/BR/noindex/table…) to readable text. */
export function flattenContent(xml: string | null): string | null {
  if (!xml) return null;
  let s = xml;
  s = s.replace(/<FnR\b[^>]*\/>/g, ''); // footnote-reference markers — the footnote body carries the content
  s = s.replace(/<\/(DT|DD|LA|P|Content|TD|TR)>/gi, '\n');
  s = s.replace(/<BR\s*\/>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeXmlEntities(s);
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s || null;
}

export interface GliederungRef {
  kennzahl: string;
  bez: string | null;
  titel: string | null;
}

export interface GiiNorm {
  doknr: string;
  isFrontMatter: boolean;
  jurabk: string | null;
  amtabk: string | null;
  enbez: string | null;
  titel: string | null;
  gliederung: GliederungRef | null;
  standangabe: { typ: string | null; kommentar: string | null }[];
  ausfertigungDatum: string | null;
  fundstelle: { periodikum: string | null; zitstelle: string | null } | null;
  langue: string | null;
  text: string | null;
  footnote: string | null;
}

export interface ParsedLaw {
  documentDoknr: string;
  builddate: string | null;
  front: GiiNorm;
  norms: GiiNorm[]; // excludes the front-matter norm itself
}

/** Parse a GiI law XML document into its front-matter norm plus the ordered rest. */
export function parseLawXml(xml: string): ParsedLaw {
  const docMatch = xml.match(/<dokumente\s+builddate="([^"]*)"\s+doknr="([^"]+)">/);
  const builddate = docMatch ? docMatch[1] || null : null;
  const documentDoknr = docMatch ? docMatch[2] : '';
  if (!documentDoknr) throw new Error('gii xml: no <dokumente doknr="..."> wrapper found — not a recognised Gesetze im Internet document.');

  const normRe = /<norm\s+builddate="[^"]*"\s+doknr="([^"]+)">([\s\S]*?)<\/norm>/g;
  const norms: GiiNorm[] = [];
  let front: GiiNorm | null = null;
  let m: RegExpExecArray | null;
  while ((m = normRe.exec(xml))) {
    const doknr = m[1];
    const body = m[2];
    const meta = rawTag(body, 'metadaten') ?? '';
    const textdaten = rawTag(body, 'textdaten');
    const textBody = textdaten ? rawTag(textdaten, 'text') : null;
    const content = textBody ? rawTag(textBody, 'Content') : null;
    const fussnoten = rawTag(body, 'fussnoten');
    const fussContent = fussnoten ? rawTag(fussnoten, 'Content') : null;

    const glBlock = rawTag(meta, 'gliederungseinheit');
    const standRaw = rawTagAll(meta, 'standangabe');

    const norm: GiiNorm = {
      doknr,
      isFrontMatter: doknr === documentDoknr,
      jurabk: leaf(meta, 'jurabk'),
      amtabk: leaf(meta, 'amtabk'),
      enbez: leaf(meta, 'enbez'),
      titel: leaf(meta, 'titel'),
      gliederung: glBlock
        ? {
            kennzahl: leaf(glBlock, 'gliederungskennzahl'),
            bez: leaf(glBlock, 'gliederungsbez'),
            titel: leaf(glBlock, 'gliederungstitel'),
          } as GliederungRef
        : null,
      standangabe: standRaw.map((s) => ({ typ: leaf(s, 'standtyp'), kommentar: leaf(s, 'standkommentar') })),
      ausfertigungDatum: leaf(meta, 'ausfertigung-datum'),
      fundstelle: (() => {
        const f = rawTag(meta, 'fundstelle');
        if (!f) return null;
        return { periodikum: leaf(f, 'periodikum'), zitstelle: leaf(f, 'zitstelle') };
      })(),
      langue: leaf(meta, 'langue'),
      text: flattenContent(content),
      footnote: flattenContent(fussContent),
    };
    if (norm.isFrontMatter && !front) front = norm;
    else norms.push(norm);
  }
  if (!front) throw new Error(`gii xml: no front-matter norm (doknr=${documentDoknr}) found in the document.`);
  return { documentDoknr, builddate, front, norms };
}

/** Parse a German free-text date "1.1.1980" / "23.7.2026" into ISO "YYYY-MM-DD", or null. */
export function parseGermanDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** The "Geltung ab: <date>" line GiI prints in the front matter's own footnote text, if present. */
export function entryIntoForce(front: GiiNorm): { raw: string | null; iso: string | null } {
  if (!front.footnote) return { raw: null, iso: null };
  const m = front.footnote.match(/Geltung ab:\s*([0-9.]+)/);
  if (!m) return { raw: null, iso: null };
  return { raw: m[1], iso: parseGermanDate(m[1]) };
}

/** Normalize a provision citation ("§ 823", "823", "823a", "Art 1", "Art. 1") down to its
 *  bare number+letter token for matching against a norm's own enbez, independent of
 *  whether the caller used "§" or "Art" (laws disagree on which symbol their own
 *  provisions use, so matching on the symbol would silently fail on the wrong guess). */
export function citationToken(raw: string): string {
  return raw
    .trim()
    .replace(/^§+\s*/, '')
    .replace(/^Art(?:ikel)?\.?\s*/i, '')
    .replace(/^Paragraph\.?\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function enbezToken(enbez: string | null): string | null {
  if (!enbez) return null;
  const t = citationToken(enbez);
  return t || null;
}
