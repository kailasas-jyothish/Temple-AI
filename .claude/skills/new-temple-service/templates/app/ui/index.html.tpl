<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<style>
  :root { --bg:#fbf7ef; --fg:#2b2118; --muted:#7a6a58; --card:#fff; --line:#e6dccb; --accent:#b4531a; --bad:#a32020; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1c1712; --fg:#f1e8d8; --muted:#b3a38d; --card:#262019; --line:#3a3127; --accent:#e08a4a; --bad:#ff8080; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { max-width:720px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  textarea { width:100%; min-height:96px; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  button { margin-top:12px; padding:10px 18px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:progress; }
  pre { margin:16px 0 0; padding:12px; background:var(--bg); border:1px solid var(--line); border-radius:8px; overflow:auto; white-space:pre-wrap; }
  .problems { color:var(--bad); margin:0 0 16px; }
</style>
</head>
<body>
<main>
  <h1>{{title}}</h1>
  <p class="sub">{{description}}</p>
  <div id="problems" class="problems"></div>
  <div class="card">
    <label for="text">Text</label>
    <textarea id="text"></textarea>
    <button id="go">Run</button>
    <pre id="out" hidden></pre>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);

  async function call(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
    return data;
  }

  call('/api/info').then((i) => { $('problems').textContent = i.problems.join(' · '); }).catch(() => {});

  $('go').addEventListener('click', async () => {
    const out = $('out');
    $('go').disabled = true;
    out.hidden = false;
    out.textContent = 'Working…';
    try {
      out.textContent = JSON.stringify(await call('/api/run', { text: $('text').value }), null, 2);
    } catch (err) {
      out.textContent = `Failed: ${err.message}`;
    } finally {
      $('go').disabled = false;
    }
  });
</script>
</body>
</html>
