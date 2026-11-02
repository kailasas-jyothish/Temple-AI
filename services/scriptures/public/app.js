const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let catalog = [];
const selected = new Set();

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderTexts() {
  const w = $('#filter').value.toLowerCase();
  const onlyDone = $('#only-done').checked;
  const rows = catalog.filter((e) => (!w || `${e.id} ${e.title} ${e.english} ${e.devanagari}`.toLowerCase().includes(w)) && (!onlyDone || e.extracted));
  $('#texts tbody').innerHTML = rows
    .map((e) => {
      const x = e.extracted;
      const check = !x ? '' : x.checked ? `<span class="${x.checkOk === x.checked ? 'ok' : 'warn'}">${x.checkOk}/${x.checked}</span>` : '<span class="muted">not checked</span>';
      const tags = [e.commentary && 'commentary', e.accented && 'accented'].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join('');
      return `<tr>
        <td><input type="checkbox" data-id="${esc(e.id)}" ${selected.has(e.id) ? 'checked' : ''}></td>
        <td><span class="deva">${esc(e.devanagari)}</span> ${esc(e.title)}${tags}<br><span class="id">${esc(e.id)}</span></td>
        <td>${x ? x.rows : ''}</td>
        <td>${x ? `${x.translated}/${x.translatable}` : ''}</td>
        <td>${check}</td>
        <td>${x ? `<a href="download/${encodeURIComponent(e.id)}.csv">CSV</a>` : ''} <button class="small ghost" data-use="${esc(e.id)}">Use</button></td>
      </tr>`;
    })
    .join('');
  $('#selected-count').textContent = selected.size ? `${selected.size} selected` : '';
}

async function loadCatalog() {
  try {
    catalog = await api('api/catalog');
    renderTexts();
  } catch (err) {
    $('#texts tbody').innerHTML = `<tr><td colspan="6" class="bad">${esc(err.message)}</td></tr>`;
  }
}

async function loadConfig() {
  const c = await api('api/config');
  $('#problems').innerHTML = c.problems.map((p) => `<p>${esc(p)}</p>`).join('');
  if (c.model && !$('#t-model').value) $('#t-model').value = c.model;
  $('#budget').textContent = `Stops at $${c.maxCostUsd} per run · prompt ${c.prompt}`;
  if (c.keySet) {
    api('api/models')
      .then((ms) => {
        $('#models').innerHTML = ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.promptPrice != null ? ` · $${m.promptPrice.toFixed(2)}/$${m.completionPrice?.toFixed(2)} per M` : ''}</option>`).join('');
      })
      .catch(() => {});
  }
}

function renderJobs(jobs) {
  if (!jobs.length) return ($('#jobs').innerHTML = '<p class="muted">No jobs yet.</p>');
  $('#jobs').innerHTML = jobs
    .slice(0, 15)
    .map((j) => {
      const what = j.type === 'extract' ? `extract ${(j.args.ids || []).length > 3 ? `${j.args.ids.length} texts` : (j.args.ids || []).join(', ')}` : `${j.type} ${j.args.id} · ${j.type === 'compare' ? (j.args.models || []).join(', ') : j.args.model}`;
      const cls = j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'running' ? 'warn' : 'muted';
      const live = j.status === 'running' || j.status === 'queued';
      const bar = j.status === 'running' && j.progress.total ? `<progress max="${j.progress.total}" value="${j.progress.done}"></progress> ${j.progress.done}/${j.progress.total} ${esc(j.progress.detail)}` : '';
      const link = j.type === 'compare' && j.status === 'done' ? ` · <a href="download/compare-${encodeURIComponent(j.args.id)}.csv">comparison CSV</a>` : j.type === 'translate' && j.status !== 'queued' ? ` · <a href="download/${encodeURIComponent(j.args.id)}.csv">CSV</a>` : '';
      return `<div class="job">
        <div class="row"><strong>${esc(what)}</strong> <span class="${cls}">${j.status}</span> ${bar}${link}
        ${live ? `<button class="small ghost" data-cancel="${j.id}">Cancel</button>` : ''}</div>
        ${j.error ? `<div class="bad">${esc(j.error)}</div>` : ''}
        ${j.log.length ? `<details ${live ? 'open' : ''}><summary class="muted">log (${j.log.length})</summary><pre>${esc(j.log.slice(-40).join('\n'))}</pre></details>` : ''}
      </div>`;
    })
    .join('');
  return jobs.some((j) => j.status === 'running' || j.status === 'queued');
}

let wasBusy = false;
async function pollJobs() {
  try {
    const busy = renderJobs(await api('api/jobs'));
    if (wasBusy && !busy) loadCatalog();
    wasBusy = busy;
    setTimeout(pollJobs, busy ? 2000 : 10000);
  } catch {
    setTimeout(pollJobs, 10000);
  }
}

async function run(path, body) {
  try {
    await api(path, body);
    wasBusy = true;
    pollJobs();
  } catch (err) {
    alert(err.message);
  }
}

$('#filter').addEventListener('input', renderTexts);
$('#only-done').addEventListener('change', renderTexts);
$('#texts').addEventListener('change', (ev) => {
  const id = ev.target.dataset?.id;
  if (!id) return;
  ev.target.checked ? selected.add(id) : selected.delete(id);
  $('#selected-count').textContent = selected.size ? `${selected.size} selected` : '';
});
$('#texts').addEventListener('click', (ev) => {
  const id = ev.target.dataset?.use;
  if (id) $('#t-id').value = id;
});
$('#extract-selected').addEventListener('click', () => {
  if (!selected.size) return alert('Tick one or more texts first.');
  run('api/extract', { ids: [...selected], refresh: $('#refresh').checked });
});
$('#translate').addEventListener('click', () =>
  run('api/translate', { id: $('#t-id').value.trim(), model: $('#t-model').value.trim(), limit: Number($('#t-limit').value) || 0, force: $('#t-force').checked }),
);
$('#compare').addEventListener('click', () => run('api/compare', { id: $('#t-id').value.trim(), models: $('#c-models').value, limit: Number($('#c-limit').value) || 5 }));
$('#jobs').addEventListener('click', async (ev) => {
  const id = ev.target.dataset?.cancel;
  if (id) await api(`api/jobs/${id}/cancel`, {}).catch((e) => alert(e.message));
});

loadConfig().catch(() => {});
loadCatalog();
pollJobs();
