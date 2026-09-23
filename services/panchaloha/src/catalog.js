// @ts-check
/**
 * The fixed vocabulary of the calculator: alloys, waxes, materials, markets.
 * Adding an entry to one of these lists is the whole job of supporting a new
 * composition, wax or market — the engine, the API and the UI all read from here.
 *
 * Shared with the browser, so no Node imports.
 */

/**
 * @typedef {object} Composition
 * @property {string} id
 * @property {string} name
 * @property {number} copperPercent
 * @property {number} gunMetalPercent
 * @property {number} zincPercent
 */

/** @type {Composition[]} */
export const COMPOSITIONS = [
  { id: '80:15:5', name: 'Standard — Copper 80%, Gun Metal 15%, Zinc 5%', copperPercent: 80, gunMetalPercent: 15, zincPercent: 5 },
  { id: '70:25:5', name: 'Copper 70%, Gun Metal 25%, Zinc 5%', copperPercent: 70, gunMetalPercent: 25, zincPercent: 5 },
];

export const DEFAULT_COMPOSITION_ID = '80:15:5';

/**
 * @typedef {'beeswax' | 'paraffin'} WaxType
 * @typedef {'copper_scrap' | 'gun_metal_scrap' | 'zinc_scrap' | 'beeswax_thaenukku' | 'paraffin_wax'} MaterialId
 * @typedef {'copperPerKg' | 'gunMetalPerKg' | 'zincPerKg' | 'beeswaxPerKg' | 'paraffinWaxPerKg'} RateKey
 */

/**
 * @typedef {object} WaxDefinition
 * @property {WaxType} id
 * @property {string} label
 * @property {MaterialId} material
 * @property {RateKey} rateKey
 */

/** @type {WaxDefinition[]} */
export const WAX_TYPES = [
  { id: 'beeswax', label: 'Beeswax (Thaenukku)', material: 'beeswax_thaenukku', rateKey: 'beeswaxPerKg' },
  { id: 'paraffin', label: 'Paraffin Wax', material: 'paraffin_wax', rateKey: 'paraffinWaxPerKg' },
];

export const DEFAULT_WAX_TYPE = /** @type {WaxType} */ ('beeswax');

/**
 * `kind` decides what the research is allowed to call a rate. A metal must come
 * back as a scrap price; a wax has no meaningful scrap market, so a supplier
 * price is what is asked for and what is accepted.
 *
 * @typedef {object} MaterialDefinition
 * @property {MaterialId} id
 * @property {RateKey} rateKey
 * @property {string} label
 * @property {'metal' | 'wax'} kind
 * @property {string} researchAs what the model is asked to find
 */

/** @type {MaterialDefinition[]} */
export const MATERIALS = [
  { id: 'copper_scrap', rateKey: 'copperPerKg', label: 'Copper scrap', kind: 'metal', researchAs: 'good-grade copper scrap (armature / heavy copper / copper wire scrap) rate at scrap dealers — not mixed or low-grade copper-bearing scrap' },
  { id: 'gun_metal_scrap', rateKey: 'gunMetalPerKg', label: 'Gun metal scrap', kind: 'metal', researchAs: 'gun metal (leaded tin bronze) scrap rate at scrap dealers' },
  { id: 'zinc_scrap', rateKey: 'zincPerKg', label: 'Zinc scrap', kind: 'metal', researchAs: 'zinc scrap rate at scrap dealers' },
  { id: 'beeswax_thaenukku', rateKey: 'beeswaxPerKg', label: 'Beeswax (Thaenukku)', kind: 'wax', researchAs: 'raw / crude beeswax (thaenukku) wholesale or supplier price' },
  { id: 'paraffin_wax', rateKey: 'paraffinWaxPerKg', label: 'Paraffin wax', kind: 'wax', researchAs: 'paraffin wax (fully / semi refined slab) wholesale or supplier price' },
];

/** Rate types a researched figure may be labelled with, per material kind. */
export const ACCEPTED_RATE_TYPES = {
  metal: ['scrap'],
  wax: ['wholesale', 'supplier', 'retail'],
};

/**
 * @typedef {object} Market
 * @property {string} id
 * @property {string} name
 * @property {string} currency ISO 4217
 * @property {string} symbol
 * @property {string} locale for number formatting
 */

/** @type {Market[]} */
export const MARKETS = [
  { id: 'IN', name: 'India', currency: 'INR', symbol: '₹', locale: 'en-IN' },
  { id: 'US', name: 'United States', currency: 'USD', symbol: '$', locale: 'en-US' },
];

export const DEFAULT_MARKET_ID = 'IN';

export const DEFAULTS = Object.freeze({
  overheadPercent: 5,
  waxRatioPercent: 10,
});

/** @param {string} id */
export const findComposition = (id) => COMPOSITIONS.find((c) => c.id === id);
/** @param {string} id */
export const findWax = (id) => WAX_TYPES.find((w) => w.id === id);
/** @param {string} id */
export const findMarket = (id) => MARKETS.find((m) => m.id === id);
/** @param {string} id */
export const findMaterial = (id) => MATERIALS.find((m) => m.id === id);
