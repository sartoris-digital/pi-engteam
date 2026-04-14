export function getDashboardHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pi-engteam observer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
  h1 { color: #7c6af7; margin-bottom: 16px; font-size: 1.4rem; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; }
  .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 12px 20px; }
  .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; }
  .stat-value { font-size: 1.6rem; font-weight: bold; color: #e0e0e0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #222; font-size: 0.85rem; }
  th { color: #888; font-weight: 500; text-transform: uppercase; font-size: 0.7rem; }
  tr:hover td { background: #1a1a1a; }
  .status-succeeded { color: #4ade80; }
  .status-failed { color: #f87171; }
  .status-running { color: #60a5fa; }
  .status-aborted { color: #fbbf24; }
  .refresh-btn { background: #7c6af7; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-bottom: 16px; }
  .refresh-btn:hover { background: #6c5ad7; }
</style>
</head>
<body>
<h1>pi-engteam observer</h1>
<div class="stats" id="stats">Loading...</div>
<button class="refresh-btn" onclick="load()">Refresh</button>
<table>
  <thead><tr><th>Run ID</th><th>Workflow</th><th>Goal</th><th>Status</th><th>Step</th><th>Iter</th><th>Updated</th></tr></thead>
  <tbody id="runs-body"></tbody>
</table>
<script>
const API = '${baseUrl}';
async function load() {
  const [statsRes, runsRes] = await Promise.all([
    fetch(API + '/stats').then(r => r.json()),
    fetch(API + '/runs?limit=50').then(r => r.json()),
  ]);

  const statsByStatus = Object.fromEntries(statsRes.runs.map(r => [r.status, r.n]));
  const total = statsRes.eventCount;
  document.getElementById('stats').innerHTML = [
    ['Total Events', total],
    ['Running', statsByStatus.running ?? 0],
    ['Succeeded', statsByStatus.succeeded ?? 0],
    ['Failed', statsByStatus.failed ?? 0],
  ].map(([l, v]) => '<div class="stat"><div class="stat-label">' + l + '</div><div class="stat-value">' + v + '</div></div>').join('');

  document.getElementById('runs-body').innerHTML = runsRes.runs.map(r =>
    '<tr>' +
    '<td><a href="' + API + '/runs/' + r.run_id + '/events" style="color:#7c6af7">' + r.run_id.slice(0, 8) + '</a></td>' +
    '<td>' + r.workflow + '</td>' +
    '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + r.goal + '">' + r.goal + '</td>' +
    '<td class="status-' + r.status + '">' + r.status + '</td>' +
    '<td>' + (r.current_step ?? '-') + '</td>' +
    '<td>' + (r.iteration ?? 0) + '</td>' +
    '<td>' + new Date(r.updated_at).toLocaleTimeString() + '</td>' +
    '</tr>'
  ).join('');
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
