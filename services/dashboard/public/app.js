const grid = document.getElementById('grid');
const summary = document.getElementById('summary');
const foot = document.getElementById('foot');
const refreshButton = document.getElementById('refresh');
const template = document.getElementById('card');

const STATE_LABEL = { up: 'Running', degraded: 'Needs attention', down: 'Down', unknown: 'Checking…' };
const cards = new Map();

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function card(id) {
  if (!cards.has(id)) {
    const node = template.content.firstElementChild.cloneNode(true);
    grid.append(node);
    cards.set(id, node);
  }
  return cards.get(id);
}

function render(snapshot) {
  const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const s of snapshot.services) {
    counts[s.state] += 1;
    const el = card(s.id);
    el.dataset.state = s.state;
    el.querySelector('.name').textContent = s.name;
    el.querySelector('.state').textContent = STATE_LABEL[s.state];
    el.querySelector('.desc').textContent = s.description;

    const open = el.querySelector('.open');
    open.href = s.url;
    open.title = s.url;

    const facts = el.querySelector('.facts');
    facts.replaceChildren(
      ...(s.details?.facts || []).map((f) => {
        const div = document.createElement('div');
        div.className = 'fact';
        if (f.tone) div.dataset.tone = f.tone;
        const dt = document.createElement('dt');
        dt.textContent = f.label;
        const dd = document.createElement('dd');
        dd.textContent = String(f.value);
        div.append(dt, dd);
        return div;
      }),
    );

    const problems = [...(s.error ? [s.error] : []), ...(s.details?.problems || [])];
    el.querySelector('.problems').replaceChildren(
      ...problems.map((p) => {
        const li = document.createElement('li');
        li.textContent = p;
        return li;
      }),
    );

    const items = el.querySelector('.items');
    const list = s.details?.items;
    items.hidden = !list?.length;
    if (list?.length) {
      el.querySelector('.items-label').textContent = s.details.itemsLabel || '';
      el.querySelector('.items-list').replaceChildren(
        ...list.map((it) => {
          const li = document.createElement('li');
          const title = it.href ? Object.assign(document.createElement('a'), { href: it.href, target: '_blank', rel: 'noopener' }) : document.createElement('span');
          title.textContent = it.title;
          li.append(title);
          if (it.detail) {
            const d = document.createElement('div');
            d.className = 'detail';
            d.textContent = it.detail;
            li.append(d);
          }
          return li;
        }),
      );
    }

    const meta = [];
    if (s.state === 'down') meta.push(s.lastUpAt ? `last up ${ago(s.lastUpAt)}` : 'not seen up since the dashboard started');
    else if (s.ms != null) meta.push(`${s.ms} ms`);
    if (s.checkedAt) meta.push(`checked ${ago(s.checkedAt)}`);
    el.querySelector('.meta').textContent = meta.join(' · ');
  }

  const total = snapshot.services.length;
  if (counts.unknown === total) summary.textContent = 'Checking services…';
  else if (counts.up === total) summary.textContent = `All ${total} services running`;
  else {
    const parts = [`${counts.up} of ${total} running`];
    if (counts.degraded) parts.push(`${counts.degraded} need${counts.degraded === 1 ? 's' : ''} attention`);
    if (counts.down) parts.push(`${counts.down} down`);
    summary.textContent = parts.join(' · ');
  }
  foot.textContent = `Checked every ${snapshot.intervalSeconds}s on the server; this page refreshes itself.`;
}

async function load(url = 'api/status', init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`status ${res.status}`);
    render(await res.json());
  } catch (err) {
    summary.textContent = `Could not reach the dashboard server (${err.message}).`;
  }
}

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Checking…';
  await load('api/refresh', { method: 'POST' });
  refreshButton.disabled = false;
  refreshButton.textContent = 'Check now';
});

load();
setInterval(load, 10_000);
