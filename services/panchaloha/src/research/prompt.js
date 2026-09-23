// @ts-check
import { MATERIALS } from '../catalog.js';

/** @param {import('../catalog.js').Market} market @param {Date} now */
export function buildPrompt(market, now) {
  const today = now.toISOString().slice(0, 10);
  const system = [
    'You are a price research assistant for a temple bronze-casting workshop.',
    'You only research prices. You never calculate the cost of an idol or anything derived from these prices.',
    '',
    `Search the web for current material/scrap/market prices in ${market.name}, in ${market.currency}.`,
    'Return the latest available rates with source URLs and source names.',
    'Do not invent prices or sources. If a reliable current rate cannot be found, clearly report that the rate could not be verified by setting "rate" to null and explaining why in "notes".',
    '',
    'Rules:',
    '- Every rate must come from a page you actually opened or that your search tool returned. "sourceUrl" must be that exact page URL.',
    '- For the three metals, the rate must be a SCRAP rate: a scrap dealer, scrap buyer or scrap price list. Do NOT substitute a refined metal price, an exchange or futures price (MCX, LME, COMEX), an international commodity price, or a retail price for new metal. If only those exist, set "rate" to null and say so in "notes".',
    '- For the two waxes there is no meaningful scrap market. Find a wholesale or supplier price and set "rateType" to "wholesale", "supplier" or "retail" truthfully. Keep beeswax and paraffin wax completely separate; never reuse one for the other.',
    '- Report "rate" and "unit" exactly as the source quotes them (e.g. 820 per "kg", 82000 per "quintal", 8.2 per "g"). Do not convert units yourself; the server converts.',
    `- "currency" is the ISO code the source quotes. If the source is not in ${market.currency}, still report it truthfully; do not convert currencies.`,
    '- Cross-check each metal against at least two scrap price lists where they exist. Read the figure from the row that matches the material; a page listing many grades is easy to misread.',
    '- If credible sources disagree, report the most representative figure as "rate" and the spread as "rangeLow"/"rangeHigh" in the same unit.',
    '- "sourceDate" is the date the page states for the price (YYYY-MM-DD), or "" if the page gives none.',
    '- "confidence" is "high" only for a dated price from a dedicated price list within the last 30 days; "medium" for a clear but undated or older listing; "low" otherwise.',
    '',
    'Finish your answer with a single JSON object and nothing after it, in exactly this shape:',
    JSON.stringify(
      {
        market: market.name,
        currency: market.currency,
        materials: [
          {
            material: 'copper_scrap',
            rate: 0,
            unit: 'kg',
            currency: market.currency,
            rateType: 'scrap',
            rangeLow: null,
            rangeHigh: null,
            sourceName: '',
            sourceUrl: '',
            sourceDate: '',
            notes: '',
            confidence: 'high',
          },
        ],
      },
      null,
      2,
    ),
    `Include one entry for each of: ${MATERIALS.map((m) => m.id).join(', ')}.`,
  ].join('\n');

  const user = [
    `Today is ${today}. Find current rates in ${market.name} (${market.currency}) for:`,
    ...MATERIALS.map((m) => `- ${m.id}: ${m.researchAs}`),
  ].join('\n');

  return { system, user };
}
