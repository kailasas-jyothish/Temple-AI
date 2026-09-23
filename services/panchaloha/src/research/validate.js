// @ts-check
/**
 * The gate between a model's answer and anything a person can approve.
 *
 * A researched rate is `verified` only if it has a positive number, a known
 * unit, the market's currency, a rate type that is honest for its material,
 * and a source URL that the provider's search tool actually returned. Anything
 * else comes back `unverified` with the reasons, and the UI will not offer it.
 * Nothing here ever reaches the calculator without a person pressing "Use".
 */
import { ACCEPTED_RATE_TYPES, MATERIALS } from '../catalog.js';
import { cmp, dec, div, isDecimalText, toNumber, ZERO } from '../decimal.js';
import { ResearchError } from './errors.js';

/**
 * @typedef {object} RateSource
 * @property {string} sourceName
 * @property {string} sourceUrl
 * @property {string} sourceDate
 * @property {'page' | 'site' | 'none'} evidenceMatch whether the exact page, or only its site, was among the search results
 */

/**
 * @typedef {object} MaterialRate
 * @property {import('../catalog.js').MaterialId} material
 * @property {string} label
 * @property {'verified' | 'unverified'} status
 * @property {number | null} ratePerKg normalised to one kg in the market currency
 * @property {number | null} rangeLowPerKg
 * @property {number | null} rangeHighPerKg
 * @property {string} currency as quoted
 * @property {{ rate: number | null, unit: string }} quoted as the source stated it
 * @property {string} rateType
 * @property {string} sourceName
 * @property {string} sourceUrl
 * @property {string} sourceDate
 * @property {RateSource['evidenceMatch']} evidenceMatch
 * @property {string} notes
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {string[]} problems why it is unverified; empty when verified
 */

/**
 * @typedef {object} RateResearchResult
 * @property {string} provider
 * @property {string} model
 * @property {string} market
 * @property {string} currency
 * @property {string} retrievedAt ISO timestamp
 * @property {MaterialRate[]} materials
 * @property {{ url: string, title?: string }[]} evidence every page the search returned
 * @property {string[]} warnings
 */

/** Kilograms per quoted unit. */
const UNIT_KG = {
  kg: '1', kgs: '1', kilogram: '1', kilograms: '1', kilo: '1',
  g: '0.001', gm: '0.001', gram: '0.001', grams: '0.001',
  '10g': '0.01', '10 g': '0.01', '10 grams': '0.01',
  quintal: '100', qtl: '100', q: '100',
  tonne: '1000', ton: '1000', t: '1000', mt: '1000', 'metric ton': '1000', 'metric tonne': '1000',
  lb: '0.45359237', lbs: '0.45359237', pound: '0.45359237',
};

/** @param {string} unit */
export function kgPerUnit(unit) {
  const key = String(unit || '').toLowerCase().replace(/^per\s+/, '').replace(/^\//, '').trim();
  return /** @type {Record<string, string>} */ (UNIT_KG)[key] || null;
}

/** Find the last balanced top-level JSON object in the model's text. */
export function extractJson(/** @type {string} */ text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of fenced.reverse()) {
    try { return JSON.parse(candidate); } catch { /* try the next one */ }
  }
  // Scan backwards for a '{' whose balanced span parses.
  // lastIndexOf clamps a negative position to 0, so stop explicitly after index 0.
  for (let start = text.lastIndexOf('{'); start >= 0; start = start === 0 ? -1 : text.lastIndexOf('{', start - 1)) {
    const end = matchBrace(text, start);
    if (end < 0) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === 'object' && Array.isArray(value.materials)) return value;
    } catch { /* keep scanning */ }
  }
  return null;
}

/** @param {string} text @param {number} start */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Comparable form of a URL: no scheme, no www, no fragment, no tracking params, no trailing slash. */
export function normaliseUrl(/** @type {string} */ raw) {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) if (/^utm_|^srsltid$|^gclid$/i.test(key)) u.searchParams.delete(key);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '');
    return { host, page: `${host}${pathname}${u.search}` };
  } catch {
    return null;
  }
}

/** @param {string} value */
const hostOf = (value) => String(value || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

/**
 * @param {string} url
 * @param {import('./providers/base.js').Evidence[]} evidence
 * @returns {RateSource['evidenceMatch']}
 */
export function matchEvidence(url, evidence) {
  const claimed = normaliseUrl(url);
  if (!claimed) return 'none';
  let site = false;
  for (const e of evidence) {
    const seen = normaliseUrl(e.url);
    if (seen && seen.page === claimed.page) return 'page';
    const hosts = [seen?.host, e.host ? hostOf(e.host) : ''].filter(Boolean);
    if (hosts.some((h) => h === claimed.host || claimed.host.endsWith(`.${h}`))) site = true;
  }
  return site ? 'site' : 'none';
}

/** @param {unknown} v */
function positiveDecimal(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return dec(v);
  if (typeof v === 'string' && isDecimalText(v.replace(/,/g, ''))) {
    const d = dec(v.replace(/,/g, ''));
    return cmp(d, ZERO) > 0 ? d : null;
  }
  return null;
}

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * @param {unknown} parsed the JSON object the model returned
 * @param {object} ctx
 * @param {import('../catalog.js').Market} ctx.market
 * @param {import('./providers/base.js').Evidence[]} ctx.evidence
 * @param {string} ctx.provider
 * @param {string} ctx.model
 * @param {Date} ctx.now
 * @returns {RateResearchResult}
 */
export function validateResearch(parsed, { market, evidence, provider, model, now }) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(/** @type {any} */ (parsed).materials)) {
    throw new ResearchError('invalid_response', 'no JSON object with a "materials" list');
  }
  const rows = /** @type {any[]} */ (/** @type {any} */ (parsed).materials);
  /** @type {string[]} */
  const warnings = [];

  const materials = MATERIALS.map((def) => {
    const row = rows.find((r) => r && typeof r === 'object' && str(r.material) === def.id);
    /** @type {string[]} */
    const problems = [];
    /** @type {MaterialRate} */
    const out = {
      material: def.id,
      label: def.label,
      status: 'unverified',
      ratePerKg: null,
      rangeLowPerKg: null,
      rangeHighPerKg: null,
      currency: str(row?.currency).toUpperCase(),
      quoted: { rate: typeof row?.rate === 'number' ? row.rate : null, unit: str(row?.unit) },
      rateType: str(row?.rateType).toLowerCase(),
      sourceName: str(row?.sourceName),
      sourceUrl: str(row?.sourceUrl),
      sourceDate: str(row?.sourceDate),
      evidenceMatch: 'none',
      notes: str(row?.notes),
      confidence: ['high', 'medium', 'low'].includes(str(row?.confidence)) ? /** @type {any} */ (str(row.confidence)) : 'low',
      problems,
    };
    if (!row) {
      problems.push('The provider did not return this material.');
      return out;
    }

    const rate = positiveDecimal(row.rate);
    if (rate) out.quoted.rate = toNumber(rate);
    const perUnit = kgPerUnit(out.quoted.unit);
    if (!rate) problems.push('No current rate could be verified.');
    if (rate && !perUnit) problems.push(`Unrecognised unit "${out.quoted.unit || '(none)'}".`);
    if (out.currency !== market.currency) {
      problems.push(out.currency ? `Currency mismatch: the source quotes ${out.currency}, not ${market.currency}.` : 'No currency given.');
    }

    const accepted = ACCEPTED_RATE_TYPES[def.kind];
    if (!accepted.includes(out.rateType)) {
      problems.push(
        def.kind === 'metal'
          ? `Reported as a "${out.rateType || 'unspecified'}" price, not a scrap rate.`
          : `Rate type "${out.rateType || 'unspecified'}" is not a wholesale, supplier or retail price.`,
      );
    }

    if (!out.sourceUrl) problems.push('No source URL — a rate without evidence cannot be used.');
    else if (!/^https?:\/\//i.test(out.sourceUrl)) problems.push('The source URL is not a web address.');
    else {
      out.evidenceMatch = matchEvidence(out.sourceUrl, evidence);
      if (out.evidenceMatch === 'none') problems.push('The source URL was not among the pages the web search returned, so it may be invented.');
      else if (out.evidenceMatch === 'site' && out.confidence === 'high') out.confidence = 'medium';
    }
    if (!out.sourceName) out.sourceName = out.sourceUrl ? hostOf(out.sourceUrl) : '';

    if (rate && perUnit) {
      const kg = dec(perUnit);
      const toPerKg = (/** @type {import('../decimal.js').Dec} */ d) => toNumber(div(d, kg, 2));
      out.ratePerKg = toPerKg(rate);
      const low = positiveDecimal(row.rangeLow);
      const high = positiveDecimal(row.rangeHigh);
      if (low && high && cmp(low, rate) <= 0 && cmp(rate, high) <= 0) {
        out.rangeLowPerKg = toPerKg(low);
        out.rangeHighPerKg = toPerKg(high);
      } else if (low || high) {
        out.notes = [out.notes, 'Reported range did not contain the working rate and was dropped.'].filter(Boolean).join(' ');
      }
      if (perUnit !== '1') {
        out.notes = [out.notes, `Converted from ${toNumber(rate)} per ${out.quoted.unit}.`].filter(Boolean).join(' ');
      }
    }

    const dated = /^\d{4}-\d{2}-\d{2}$/.test(out.sourceDate) ? new Date(`${out.sourceDate}T00:00:00Z`) : null;
    if (dated && !Number.isNaN(dated.getTime())) {
      const days = Math.floor((now.getTime() - dated.getTime()) / 86_400_000);
      if (days > 60) out.notes = [out.notes, `Source is ${days} days old.`].filter(Boolean).join(' ');
      if (days > 30 && out.confidence === 'high') out.confidence = 'medium';
    } else if (out.confidence === 'high') {
      out.confidence = 'medium';
    }

    if (!problems.length) out.status = 'verified';
    return out;
  });

  const verified = materials.filter((m) => m.status === 'verified').length;
  if (!verified) warnings.push('No rate could be verified. Enter the rates manually or try another provider.');
  else if (verified < materials.length) warnings.push(`${materials.length - verified} of ${materials.length} rates could not be verified; enter those manually.`);

  // A verified source proves the page exists, not that the figure was read
  // off the right row. These orderings hold in every market this was checked
  // against; when one breaks, a person should look before approving. The
  // first real Groq run returned copper at ₹607 against gun metal at ₹1,095 —
  // the cited copper page was real, and the figure was not the heavy-scrap rate.
  const rate = (/** @type {string} */ id) => materials.find((m) => m.material === id && m.status === 'verified')?.ratePerKg ?? null;
  const copperRate = rate('copper_scrap');
  const gunMetalRate = rate('gun_metal_scrap');
  if (copperRate !== null && gunMetalRate !== null && gunMetalRate > copperRate) {
    warnings.push('Gun metal came back dearer than copper. Gun metal is mostly copper and normally trades below it — open both sources before using either rate.');
  }
  const beeswaxRate = rate('beeswax_thaenukku');
  const paraffinRate = rate('paraffin_wax');
  if (beeswaxRate !== null && paraffinRate !== null && paraffinRate > beeswaxRate) {
    warnings.push('Paraffin wax came back dearer than beeswax, which is unusual — check both sources.');
  }

  // Mention it, but do not fail: a model occasionally writes "India" differently.
  const reportedCurrency = str(/** @type {any} */ (parsed).currency).toUpperCase();
  if (reportedCurrency && reportedCurrency !== market.currency) {
    warnings.push(`The provider reported ${reportedCurrency} overall; only ${market.currency} rates were accepted.`);
  }

  const seen = new Set();
  const uniqueEvidence = evidence
    .filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
    .map((e) => ({ url: e.url, title: e.title }));

  return {
    provider,
    model,
    market: market.name,
    currency: market.currency,
    retrievedAt: now.toISOString(),
    materials,
    evidence: uniqueEvidence,
    warnings,
  };
}
