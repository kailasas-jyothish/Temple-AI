// The page runs the same engine as the server (/lib/ is src/), so every result
// updates as you type and is identical to POST /api/calculate.
import { calculateMurthyCost, compositionFractions, validateInput } from '/lib/calculator.js';
import { isDecimalText, percent, toText } from '/lib/decimal.js';

const STORE_KEY = 'panchaloha:v1';
const RATE_KEYS = ['copperPerKg', 'gunMetalPerKg', 'zincPerKg', 'beeswaxPerKg', 'paraffinWaxPerKg'];

/** @type {any} */ let catalog;
/** @type {any} */ let state;
/** @type {any} */ let lastResearch = null;

const $ = (id) => document.getElementById(id);

/** Build an element; children may be strings (always text, never HTML). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** Only http(s) links from research are ever rendered as links. */
function safeLink(url, text) {
  return /^https?:\/\//i.test(url || '') ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || url) : text || url || '';
}

// ------------------------------------------------------------------ state

function defaults() {
  const d = catalog.defaults;
  return {
    weight: '',
    compositionId: d.compositionId,
    defaultCompositionId: d.compositionId,
    waxType: d.waxType,
    market: d.market,
    provider: d.provider,
    models: {},        // provider id -> chosen model id
    customModel: {},   // provider id -> true while "Custom model id…" is selected
    overheadPercent: String(d.overheadPercent),
    waxRatioPercent: String(d.waxRatioPercent),
    ratesByMarket: {},
  };
}

function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') Object.assign(base, saved);
  } catch { /* private window or blocked storage: run on defaults */ }
  if (!catalog.compositions.some((c) => c.id === base.compositionId)) base.compositionId = catalog.defaults.compositionId;
  if (!catalog.markets.some((m) => m.id === base.market)) base.market = catalog.defaults.market;
  if (!catalog.providers.some((p) => p.id === base.provider)) base.provider = catalog.defaults.provider;
  return base;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* not fatal */ }
}

const market = () => catalog.markets.find((m) => m.id === state.market);
const composition = () => catalog.compositions.find((c) => c.id === state.compositionId);
const waxDef = () => catalog.waxTypes.find((w) => w.id === state.waxType);

/** Rates for the current market: { [rateKey]: { value, origin: 'manual'|'ai', source? } } */
function rates() {
  state.ratesByMarket[state.market] ||= {};
  const r = state.ratesByMarket[state.market];
  for (const key of RATE_KEYS) r[key] ||= { value: '', origin: 'manual' };
  return r;
}

// ------------------------------------------------------------------ formatting

function money(n) {
  const m = market();
  return new Intl.NumberFormat(m.locale, { style: 'currency', currency: m.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function kg(n) {
  return `${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 5 }).format(n)} kg`;
}
function plain(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 5 }).format(n);
}
function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ------------------------------------------------------------------ inputs

function renderStatic() {
  const compSelect = $('composition');
  compSelect.replaceChildren(...catalog.compositions.map((c) => el('option', { value: c.id }, `${c.id} — ${c.name}`)));

  $('wax-options').replaceChildren(
    ...catalog.waxTypes.map((w) =>
      el('label', { class: 'radio-card' },
        el('input', { type: 'radio', name: 'wax', value: w.id, onchange: () => { state.waxType = w.id; update(); } }),
        w.label),
    ),
  );

  $('rate-rows').replaceChildren(
    ...catalog.materials.map((m) => {
      const input = el('input', {
        id: `rate-${m.rateKey}`,
        inputmode: 'decimal',
        placeholder: '0.00',
        'aria-describedby': `meta-${m.rateKey}`,
        oninput: (e) => {
          const r = rates()[m.rateKey];
          // Editing an AI rate makes it the person's own figure.
          const wasAi = r.origin === 'ai';
          r.value = e.target.value;
          r.origin = 'manual';
          r.editedFrom = wasAi ? r.source : r.editedFrom;
          delete r.source;
          update({ skipRateInputs: true });
        },
      });
      return el('div', { class: 'rate-row', id: `row-${m.rateKey}` },
        el('label', { for: input.id }, m.label),
        el('div', { class: 'input-affix prefix' }, el('span', { class: 'affix currency-symbol' }), input),
        el('div', { class: 'rate-meta', id: `meta-${m.rateKey}` }));
    }),
  );

  $('weight').addEventListener('input', (e) => { state.weight = e.target.value; update(); });
  compSelect.addEventListener('change', (e) => { state.compositionId = e.target.value; update(); });
}

function renderInputs({ skipRateInputs = false } = {}) {
  const m = market();
  if (document.activeElement !== $('weight')) $('weight').value = state.weight;
  $('composition').value = state.compositionId;
  const c = composition();
  $('composition-hint').textContent = `Copper ${c.copperPercent}% · Gun metal ${c.gunMetalPercent}% · Zinc ${c.zincPercent}%`;
  for (const radio of document.querySelectorAll('input[name="wax"]')) radio.checked = radio.value === state.waxType;
  $('wax-hint').textContent = `Wax quantity is ${plain(Number(state.waxRatioPercent) || 0)}% of the murthy weight.`;

  $('rates-unit').textContent = `(${m.currency} / kg)`;
  for (const s of document.querySelectorAll('.currency-symbol')) s.textContent = m.symbol;

  const r = rates();
  const selectedKey = waxDef().rateKey;
  for (const mat of catalog.materials) {
    const entry = r[mat.rateKey];
    const input = $(`rate-${mat.rateKey}`);
    if (!skipRateInputs || document.activeElement !== input) input.value = entry.value;
    const isWax = mat.kind === 'wax';
    const used = !isWax || mat.rateKey === selectedKey;
    $(`row-${mat.rateKey}`).classList.toggle('reference', !used);

    const meta = $(`meta-${mat.rateKey}`);
    const parts = [];
    if (isWax) parts.push(el('span', { class: `badge ${used ? 'used' : ''}` }, used ? 'In use' : 'Reference only'));
    if (entry.origin === 'ai' && entry.source) {
      const s = entry.source;
      parts.push(el('span', { class: 'badge ai' }, 'AI researched'));
      parts.push(safeLink(s.sourceUrl, s.sourceName || 'source'));
      parts.push(` · ${s.sourceDate ? `dated ${s.sourceDate}` : 'undated'} · retrieved ${when(s.retrievedAt)}`);
    } else if (entry.value) {
      parts.push(el('span', { class: 'badge' }, 'Manual'));
      if (entry.editedFrom) parts.push(`edited from an AI rate (${entry.editedFrom.sourceName || 'source'})`);
    }
    meta.replaceChildren(...parts);
  }

  renderResearchControls();
}

// ------------------------------------------------------------------ calculation

function currentInput() {
  const r = rates();
  return {
    murthyWeightKg: state.weight,
    composition: compositionFractions(composition()),
    // Percent -> fraction exactly; 1.1 / 100 in floating point is 0.011000000000000001.
    wax: { type: state.waxType, ratio: isDecimalText(state.waxRatioPercent) ? toText(percent(state.waxRatioPercent)) : state.waxRatioPercent },
    rates: Object.fromEntries(RATE_KEYS.map((k) => [k, r[k].value])),
    overheadPercent: state.overheadPercent,
  };
}

function row(label, value, cls = '') {
  return el('tr', { class: cls }, el('th', { scope: 'row' }, label), el('td', {}, value));
}

function renderResults() {
  const input = currentInput();
  const errors = validateInput(input);
  const weightError = errors.find((e) => e.field === 'murthyWeightKg');
  $('weight-error').textContent = state.weight === '' ? '' : weightError?.message || '';
  $('weight').setAttribute('aria-invalid', state.weight !== '' && weightError ? 'true' : 'false');
  for (const key of RATE_KEYS) {
    const input = $(`rate-${key}`);
    const bad = errors.some((e) => e.field === `rates.${key}`) && rates()[key].value !== '';
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }

  const c = composition();
  const w = waxDef();
  if (errors.length) {
    $('final-rate').textContent = '—';
    $('final-sub').textContent = 'Nothing is calculated until every required value is present and valid:';
    $('problems').replaceChildren(...errors.map((e) => el('li', {}, e.message)));
    $('requirement-table').replaceChildren(row('Waiting for a valid weight and rates', '', 'empty'));
    $('cost-table').replaceChildren(row('Waiting for a valid weight and rates', '', 'empty'));
    $('breakdown').replaceChildren(el('li', {}, 'Complete the inputs to see each step.'));
    return;
  }

  const r = calculateMurthyCost(input);
  $('final-rate').replaceChildren(money(r.finalRatePerKg), el('span', { class: 'per' }, '/ kg'));
  $('final-sub').textContent = `${plain(r.murthyWeightKg)} kg murthy · ${c.id} · ${w.label} · total ${money(r.finalTotalCost)}`;
  $('problems').replaceChildren();

  $('requirement-table').replaceChildren(
    row(`Copper (${c.copperPercent}%)`, kg(r.quantities.copperKg)),
    row(`Gun metal (${c.gunMetalPercent}%)`, kg(r.quantities.gunMetalKg)),
    row(`Zinc (${c.zincPercent}%)`, kg(r.quantities.zincKg)),
    row(`${w.label} (${plain(Number(state.waxRatioPercent))}% of weight)`, kg(r.quantities.waxKg)),
  );

  $('cost-table').replaceChildren(
    row('Raw material', money(r.rawMaterialCost)),
    row(`${plain(r.overheadPercent)}% overhead`, money(r.overheadAmount)),
    row('Material rate', money(r.materialRate)),
    row('Labour (= material rate)', money(r.labourCharge)),
    row('Final total', money(r.finalTotalCost), 'total'),
    row('Final rate per kg', `${money(r.finalRatePerKg)} / kg`, 'sub'),
  );

  const line = (title, detail) => el('li', {}, el('strong', {}, title), el('span', {}, detail));
  $('breakdown').replaceChildren(
    line('Copper', `${kg(r.quantities.copperKg)} × ${money(r.ratesUsed.copper)}/kg = ${money(r.componentCosts.copper)}`),
    line('Gun metal', `${kg(r.quantities.gunMetalKg)} × ${money(r.ratesUsed.gunMetal)}/kg = ${money(r.componentCosts.gunMetal)}`),
    line('Zinc', `${kg(r.quantities.zincKg)} × ${money(r.ratesUsed.zinc)}/kg = ${money(r.componentCosts.zinc)}`),
    line(`Wax — ${w.label}`, `${kg(r.quantities.waxKg)} × ${money(r.ratesUsed.wax)}/kg = ${money(r.componentCosts.wax)}`),
    line('Raw material cost', `${money(r.metalCost)} metal + ${money(r.componentCosts.wax)} wax = ${money(r.rawMaterialCost)}`),
    line('Material rate', `${money(r.rawMaterialCost)} + ${plain(r.overheadPercent)}% overhead (${money(r.overheadAmount)}) = ${money(r.materialRate)}`),
    line('Labour charge', `= material rate = ${money(r.labourCharge)}`),
    line('Final total', `${money(r.materialRate)} material + ${money(r.labourCharge)} labour = ${money(r.finalTotalCost)}`),
    line('Final rate per kg', `${money(r.finalTotalCost)} ÷ ${plain(r.murthyWeightKg)} kg = ${money(r.finalRatePerKg)}/kg`),
  );
}

function update(opts) {
  renderInputs(opts);
  renderResults();
  save();
}

// ------------------------------------------------------------------ research

let researching = false;

const CUSTOM = '__custom__';
/** Per provider: { status: 'loading'|'ok'|'error', models: [{id,label}], error } — this page load only. */
const modelLists = {};
/** "provider:model" pairs that failed this session, so the list can say so. */
const failedModels = new Map();

const currentProvider = () => catalog.providers.find((p) => p.id === state.provider);
/** The model research will use: the person's choice for this provider, else the server default. */
const currentModel = () => (state.models?.[state.provider] ?? currentProvider()?.model ?? '').trim();

async function loadModels(providerId, { force = false } = {}) {
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (!provider?.configured) return;
  if (!force && modelLists[providerId] && modelLists[providerId].status !== 'error') return;
  modelLists[providerId] = { status: 'loading', models: [] };
  renderResearchControls();
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) throw new Error(body?.error?.message || `HTTP ${res.status}`);
    modelLists[providerId] = { status: 'ok', models: body.models || [] };
  } catch (err) {
    modelLists[providerId] = { status: 'error', models: [], error: err.message || String(err) };
  }
  renderResearchControls();
}

function renderResearchControls() {
  const providerSelect = $('research-provider');
  providerSelect.replaceChildren(...catalog.providers.map((p) =>
    el('option', { value: p.id }, p.configured ? p.label : `${p.label} (no API key)`)));
  providerSelect.value = state.provider;
  providerSelect.disabled = researching;

  const provider = currentProvider();
  const list = modelLists[state.provider];
  const chosen = currentModel();
  const customMode = state.customModel?.[state.provider] === true;
  const listed = (list?.models || []).map((x) => x.id);
  const failedLabel = (id) => (failedModels.has(`${state.provider}:${id}`) ? ' — failed last try' : '');

  /** @type {HTMLElement[]} */
  const options = [];
  // The chosen model always appears, listed or not: the list can lag a release,
  // and an env default the key cannot see should still be visible as such.
  if (chosen && !listed.includes(chosen) && !customMode) {
    options.push(el('option', { value: chosen }, `${chosen}${chosen === provider?.model ? ' (default)' : ''}${list?.status === 'ok' ? ' — not offered to this key' : ''}${failedLabel(chosen)}`));
  }
  for (const m of list?.models || []) {
    const tag = m.id === provider?.model ? ' (default)' : '';
    options.push(el('option', { value: m.id }, `${m.label && m.label !== m.id ? `${m.label} — ${m.id}` : m.id}${tag}${failedLabel(m.id)}`));
  }
  options.push(el('option', { value: CUSTOM }, 'Custom model id…'));
  const modelSelect = $('research-model');
  modelSelect.replaceChildren(...options);
  modelSelect.value = customMode ? CUSTOM : chosen;
  modelSelect.disabled = !provider?.configured || researching;

  const custom = $('research-model-custom');
  custom.hidden = !customMode;
  if (customMode && document.activeElement !== custom) custom.value = chosen;
  custom.disabled = researching;

  const m = market();
  let line;
  if (!provider?.configured) line = `No API key for ${provider?.label || 'this provider'} is set on the server. Choose another provider, or enter rates manually.`;
  else if (!list || list.status === 'loading') line = `Loading the models your ${provider.label} key can use…`;
  else if (list.status === 'error') line = `Could not list ${provider.label} models (${list.error}). You can still choose “Custom model id…” and type one.`;
  else if (!list.models.length) line = `${provider.label} lists no web-search-capable models for this key. Try another provider, or type a model id.`;
  else line = `${list.models.length} web-search-capable model${list.models.length === 1 ? '' : 's'} available to this key. Research runs for ${m.name}, in ${m.currency}.`;
  $('research-provider-line').textContent = line;

  $('research-btn').disabled = !provider?.configured || researching || !chosen;
}

$('research-provider').addEventListener('change', (e) => {
  state.provider = e.target.value;
  save();
  renderResearchControls();
  loadModels(state.provider);
});
$('research-model').addEventListener('change', (e) => {
  state.models ||= {};
  state.customModel ||= {};
  if (e.target.value === CUSTOM) {
    state.customModel[state.provider] = true;
    state.models[state.provider] = '';
    renderResearchControls();
    $('research-model-custom').focus();
  } else {
    state.customModel[state.provider] = false;
    state.models[state.provider] = e.target.value;
    renderResearchControls();
  }
  save();
});
$('research-model-custom').addEventListener('input', (e) => {
  state.models ||= {};
  state.models[state.provider] = e.target.value;
  save();
  $('research-btn').disabled = researching || !e.target.value.trim();
});

async function runResearch() {
  const m = market();
  const provider = currentProvider();
  const model = currentModel();
  researching = true;
  lastResearch = null;
  $('research-btn').disabled = true;
  $('research-btn').replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Searching…');
  $('research-panel').hidden = false;
  $('use-all-btn').hidden = true;
  $('research-body').replaceChildren(
    el('div', { class: 'notice info' }, `${provider.label} (${model}) is searching the web for ${m.name} rates in ${m.currency}. This usually takes one to three minutes. Your current rates are not changed by this.`),
  );
  renderResearchControls();
  let failure = null;
  try {
    const res = await fetch('/api/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: state.provider, market: state.market, model }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) {
      failure = { code: body?.error?.code || 'http', message: body?.error?.message || `Research failed (HTTP ${res.status}). Enter rates manually.` };
    } else {
      failedModels.delete(`${state.provider}:${model}`);
      lastResearch = { ...body, marketId: state.market };
    }
  } catch (err) {
    failure = { code: 'network', message: err.message || String(err) };
  } finally {
    researching = false;
    $('research-btn').replaceChildren(el('span', { 'aria-hidden': 'true' }, '✨'), ' Get latest rates');
  }

  if (failure) {
    // These are all "this model, here, now" failures: another model is the fix.
    const modelProblem = ['model_unavailable', 'web_search_unavailable', 'rate_limited', 'timeout', 'invalid_response', 'provider_unavailable'].includes(failure.code);
    if (modelProblem) failedModels.set(`${state.provider}:${model}`, failure.code);
    $('research-body').replaceChildren(
      el('div', { class: 'notice bad', role: 'alert' },
        el('strong', {}, `${provider.label} · ${model}: `), failure.message),
      modelProblem
        ? el('div', { class: 'notice info' }, 'Pick a different model or provider above and press “Get latest rates” again. Your rates were not changed.')
        : null,
    );
    // A list fetched before the failure may itself be stale; ask again.
    if (failure.code === 'model_unavailable') loadModels(state.provider, { force: true });
  } else {
    renderResearch();
  }
  renderInputs();
  if (failure) $('research-model').focus();
}

function useRate(item) {
  const mat = catalog.materials.find((m) => m.id === item.material);
  const entry = rates()[mat.rateKey];
  entry.value = String(item.ratePerKg);
  entry.origin = 'ai';
  entry.source = {
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    sourceDate: item.sourceDate,
    retrievedAt: lastResearch.retrievedAt,
    provider: lastResearch.provider,
    confidence: item.confidence,
  };
  delete entry.editedFrom;
}

function renderResearch() {
  const data = lastResearch;
  if (!data) return;
  const m = catalog.markets.find((x) => x.id === data.marketId);
  const sameMarket = data.marketId === state.market;
  const fmt = (n) => new Intl.NumberFormat(m.locale, { style: 'currency', currency: m.currency }).format(n);
  const verified = data.materials.filter((x) => x.status === 'verified');
  $('use-all-btn').hidden = !verified.length || !sameMarket;

  const items = data.materials.map((item) => {
    const mat = catalog.materials.find((x) => x.id === item.material);
    const current = rates()[mat.rateKey];
    const ok = item.status === 'verified';
    const conf = { high: 'ok', medium: 'warn', low: 'bad' }[item.confidence];
    const inUse = current.origin === 'ai' && current.value === String(item.ratePerKg) && current.source?.retrievedAt === data.retrievedAt;
    return el('article', { class: `research-item ${ok ? '' : 'unverified'}` },
      el('div', { class: 'research-top' },
        el('div', {},
          el('strong', {}, item.label), ' ',
          ok ? el('span', { class: `badge ${conf}` }, `${item.confidence} confidence`) : el('span', { class: 'badge bad' }, 'Not verified')),
        ok
          ? el('div', { class: 'research-rate' }, `${fmt(item.ratePerKg)} / kg`)
          : el('div', { class: 'muted' }, 'No usable rate')),
      ok && item.rangeLowPerKg !== null
        ? el('p', { class: 'hint' }, `Observed range ${fmt(item.rangeLowPerKg)}–${fmt(item.rangeHighPerKg)}/kg · working rate is an estimate, not an exact price.`)
        : ok ? el('p', { class: 'hint' }, 'Working rate is an estimate, not an exact price.') : null,
      el('dl', {},
        el('dt', {}, 'Source'), el('dd', {}, item.sourceUrl ? safeLink(item.sourceUrl, item.sourceName || item.sourceUrl) : '—'),
        el('dt', {}, 'Rate type'), el('dd', {}, item.rateType || '—'),
        el('dt', {}, 'Source date'), el('dd', {}, item.sourceDate || 'not stated'),
        !ok && item.quoted?.rate ? [el('dt', {}, 'Figure given'), el('dd', {}, `${item.quoted.rate} ${item.currency || ''} per ${item.quoted.unit || '?'} — not usable`)] : null,
        item.evidenceMatch === 'site' ? [el('dt', {}, 'Evidence'), el('dd', {}, 'The site was among the search results, the exact page was not.')] : null,
        item.notes ? [el('dt', {}, 'Notes'), el('dd', {}, item.notes)] : null),
      item.problems.length ? el('ul', {}, item.problems.map((p) => el('li', {}, p))) : null,
      ok && sameMarket
        ? el('div', { style: 'margin-top:0.6rem' },
            el('button', {
              type: 'button', class: 'btn small', disabled: inUse,
              onclick: () => { useRate(item); update(); renderResearch(); },
            }, inUse ? 'In use' : current.value ? `Use this rate (replaces ${m.symbol}${current.value})` : 'Use this rate'))
        : null);
  });

  // replaceChildren would print a literal "null"; el() skips it.
  $('research-body').replaceChildren(el('div', {},
    el('p', { class: 'hint' }, `${data.provider} · ${data.model} · ${data.market} (${data.currency}) · retrieved ${when(data.retrievedAt)}`),
    !sameMarket ? el('div', { class: 'notice warn' }, `These rates are for ${m.name}; switch the market back to use them.`) : null,
    ...data.warnings.map((w) => el('div', { class: 'notice warn' }, w)),
    ...items,
    data.evidence.length
      ? el('details', { class: 'evidence' },
          el('summary', {}, `Pages the web search returned (${data.evidence.length})`),
          el('ol', {}, data.evidence.map((e) => el('li', {}, safeLink(e.url, e.title || e.url)))))
      : null,
  ));
}

$('use-all-btn').addEventListener('click', () => {
  const verified = lastResearch.materials.filter((x) => x.status === 'verified');
  const replacing = verified
    .map((item) => catalog.materials.find((x) => x.id === item.material))
    .filter((mat) => rates()[mat.rateKey].origin === 'manual' && rates()[mat.rateKey].value !== '');
  if (replacing.length && !confirm(`This replaces your own rates for: ${replacing.map((x) => x.label).join(', ')}. Continue?`)) return;
  for (const item of verified) useRate(item);
  update();
  renderResearch();
});

// ------------------------------------------------------------------ settings

function openSettings() {
  $('set-market').replaceChildren(...catalog.markets.map((m) => el('option', { value: m.id }, m.name)));
  $('set-composition').replaceChildren(...catalog.compositions.map((c) => el('option', { value: c.id }, c.id)));
  $('set-market').value = state.market;
  $('set-composition').value = state.defaultCompositionId;
  $('set-overhead').value = state.overheadPercent;
  $('set-wax-ratio').value = state.waxRatioPercent;
  syncCurrency();
  $('settings-error').textContent = '';
  $('settings').showModal();
}

function syncCurrency() {
  const m = catalog.markets.find((x) => x.id === $('set-market').value);
  $('set-currency').value = `${m.currency} (${m.symbol})`;
}

$('open-settings').addEventListener('click', openSettings);
$('set-market').addEventListener('change', syncCurrency);
$('cancel-settings').addEventListener('click', () => $('settings').close());
$('reset-settings').addEventListener('click', () => {
  const d = defaults();
  $('set-market').value = d.market;
  $('set-composition').value = d.compositionId;
  $('set-overhead').value = d.overheadPercent;
  $('set-wax-ratio').value = d.waxRatioPercent;
  syncCurrency();
});
$('settings-form').addEventListener('submit', (e) => {
  const overhead = $('set-overhead').value.trim();
  const ratio = $('set-wax-ratio').value.trim();
  const num = /^\d+(\.\d+)?$/;
  if (!num.test(overhead) || Number(overhead) > 100) {
    e.preventDefault();
    $('settings-error').textContent = 'Overhead % must be a number from 0 to 100.';
    return;
  }
  if (!num.test(ratio) || Number(ratio) <= 0 || Number(ratio) > 100) {
    e.preventDefault();
    $('settings-error').textContent = 'Wax ratio % must be a number above 0 and at most 100.';
    return;
  }
  const newDefaultComposition = $('set-composition').value;
  if (newDefaultComposition !== state.defaultCompositionId) state.compositionId = newDefaultComposition;
  state.defaultCompositionId = newDefaultComposition;
  state.market = $('set-market').value;
  state.overheadPercent = overhead;
  state.waxRatioPercent = ratio;
  update();
  if (lastResearch) renderResearch();
});

$('research-btn').addEventListener('click', runResearch);

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    catalog = await res.json();
  } catch (err) {
    document.querySelector('main').replaceChildren(el('div', { class: 'card notice bad' }, `Could not load the calculator configuration: ${err.message}`));
    return;
  }
  state = load();
  state.models ||= {};
  state.customModel ||= {};
  renderStatic();
  update();
  loadModels(state.provider);
})();
