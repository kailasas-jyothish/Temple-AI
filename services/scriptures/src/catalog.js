// @ts-check
// The Upanishad index page lists every text as one <li>: links to .pdf, .itx
// and .html, the Devanagari title, the English name, and a free-text note.

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   devanagari: string,
 *   english: string,
 *   note: string,
 *   commentary: boolean,
 *   accented: boolean,
 * }} CatalogEntry
 */

/** @param {string} s */
function clean(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Commentaries (bhāṣya, ṭīkā, …) are long prose that this pipeline can parse
// but that is not a verse text; they are listed and flagged, not hidden.
const COMMENTARY = /bh[Aa]a?Shy|bhaashhy|bhashya|commentary|T[Ii]k[Aa]|vy[Aa]khy|d[Ii]pik|vivaraN|vRitti/i;
const ACCENTED = /accent|svara|sasvar/i;

/**
 * @param {string} html
 * @param {string} dir the catalog path, e.g. "/doc_upanishhat/"
 * @returns {CatalogEntry[]}
 */
export function parseCatalog(html, dir = '/doc_upanishhat/') {
  const esc = dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  /** @type {Map<string, CatalogEntry>} */
  const out = new Map();
  for (const li of html.split(/<li\b/i).slice(1)) {
    const itx = new RegExp(`href="${esc}([^"/]+)\\.itx"`).exec(li);
    if (!itx) continue;
    const id = decodeURIComponent(itx[1]);
    const page = new RegExp(`href="${esc}[^"]+\\.html"\\s+title="([^"]*)"`).exec(li);
    const deva = /<em lang="sa">([\s\S]*?)<\/em>/i.exec(li);
    const name = /<em itemprop="name">([\s\S]*?)<\/em>/i.exec(li);
    const tail = li.split(/<em itemprop="name">[\s\S]*?<\/em>\s*(?:<\/a>)?\s*\|/i)[1] || '';
    const title = page ? clean(page[1]) : id;
    const english = name ? clean(name[1]) : title;
    const entry = {
      id,
      title,
      devanagari: deva ? clean(deva[1]) : '',
      english,
      note: clean(tail.replace(/<\/li>[\s\S]*/i, '')).replace(/^\(|\)$/g, ''),
      commentary: COMMENTARY.test(`${id} ${title} ${english}`),
      accented: ACCENTED.test(`${id} ${title} ${english}`),
    };
    if (!out.has(id)) out.set(id, entry);
  }
  return [...out.values()];
}
