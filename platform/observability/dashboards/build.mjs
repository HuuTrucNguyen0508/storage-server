#!/usr/bin/env node
// Generates the lab's Grafana dashboards as JSON under dashboards/<folder>/<uid>.json.
// install.sh turns each file into a ConfigMap that Grafana's sidecar provisions into the
// folder named after the directory. Edit this file, then run:
//   node platform/observability/dashboards/build.mjs
// and commit the regenerated JSON. No dependencies.
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const DS = {
  prom: { type: 'prometheus', uid: 'prometheus' },
  loki: { type: 'loki', uid: 'loki' },
  tempo: { type: 'tempo', uid: 'tempo' },
};

// ---------------------------------------------------------------------------
// Panel helpers. Layout: each helper takes w/h; rows flow left to right on a 24-wide grid.
// ---------------------------------------------------------------------------

let nextId = 1;
let cursor = { x: 0, y: 0, rowH: 0 };
function place(w, h) {
  if (cursor.x + w > 24) {
    cursor = { x: 0, y: cursor.y + cursor.rowH, rowH: 0 };
  }
  const pos = { x: cursor.x, y: cursor.y, w, h };
  cursor.x += w;
  cursor.rowH = Math.max(cursor.rowH, h);
  return pos;
}
function resetLayout() {
  nextId = 1;
  cursor = { x: 0, y: 0, rowH: 0 };
}

const prom = (expr, legendFormat = '', extra = {}) => ({ datasource: DS.prom, expr, legendFormat, range: true, ...extra });
const loki = (expr, extra = {}) => ({ datasource: DS.loki, expr, queryType: 'range', ...extra });

function withRefIds(targets) {
  return targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t }));
}

function row(title, { collapsed = false, panels = [] } = {}) {
  cursor = { x: 0, y: cursor.y + cursor.rowH, rowH: 0 };
  const p = { id: nextId++, type: 'row', title, collapsed, gridPos: place(24, 1), panels };
  cursor = { x: 0, y: cursor.y + 1, rowH: 0 };
  return p;
}

function text(content, { w = 24, h = 3, title = '' } = {}) {
  return { id: nextId++, type: 'text', title, gridPos: place(w, h), options: { mode: 'markdown', content } };
}

function timeseries(title, targets, o = {}) {
  const {
    w = 12, h = 8, unit = 'short', stack = false, min, max, decimals, description = '',
    fill = 10, legend = 'list', thresholds, overrides = [], datasource = DS.prom, links = [], bars = false,
  } = o;
  return {
    id: nextId++, type: 'timeseries', title, description, datasource, gridPos: place(w, h), links,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit, min, max, decimals,
        color: { mode: 'palette-classic' },
        custom: {
          drawStyle: bars ? 'bars' : 'line', lineWidth: 1, fillOpacity: fill, showPoints: 'never', spanNulls: false,
          stacking: { mode: stack ? 'normal' : 'none', group: 'A' },
          axisSoftMin: min === undefined ? undefined : min,
        },
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'green', value: null }] },
      },
      overrides,
    },
    options: {
      legend: { displayMode: legend, placement: 'bottom', showLegend: legend !== 'hidden', calcs: legend === 'table' ? ['mean', 'max', 'lastNotNull'] : [] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  };
}

function stat(title, targets, o = {}) {
  const {
    w = 4, h = 4, unit = 'short', decimals, thresholds, mappings = [], colorMode = 'value', graph = 'none',
    description = '', reduce = 'lastNotNull', textMode = 'auto', links = [], noValue,
  } = o;
  return {
    id: nextId++, type: 'stat', title, description, datasource: DS.prom, gridPos: place(w, h), links,
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: {
        unit, decimals, mappings, noValue,
        color: { mode: 'thresholds' },
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'blue', value: null }] },
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: [reduce], fields: '', values: false },
      colorMode, graphMode: graph, justifyMode: 'auto', textMode, orientation: 'auto', wideLayout: true,
      showPercentChange: false,
    },
  };
}

function gauge(title, targets, o = {}) {
  const { w = 4, h = 6, unit = 'percentunit', min = 0, max = 1, thresholds, description = '' } = o;
  return {
    id: nextId++, type: 'gauge', title, description, datasource: DS.prom, gridPos: place(w, h),
    targets: withRefIds(targets),
    fieldConfig: {
      defaults: { unit, min, max, color: { mode: 'thresholds' }, thresholds: thresholds ?? T.lowIsBad(0.1, 0.2) },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdLabels: false, showThresholdMarkers: true },
  };
}

function table(title, targets, o = {}) {
  const { w = 24, h = 8, transformations = [], overrides = [], unit = 'short', description = '', sortBy = [], datasource = DS.prom } = o;
  return {
    id: nextId++, type: 'table', title, description, datasource, gridPos: place(w, h),
    targets: withRefIds(targets),
    fieldConfig: { defaults: { unit, custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], fields: '' }, sortBy },
    transformations,
  };
}

function logs(title, expr, o = {}) {
  const { w = 24, h = 12, description = '' } = o;
  return {
    id: nextId++, type: 'logs', title, description, datasource: DS.loki, gridPos: place(w, h),
    targets: withRefIds([loki(expr)]),
    options: {
      showTime: true, showLabels: false, showCommonLabels: false, wrapLogMessage: true, prettifyLogMessage: false,
      enableLogDetails: true, enableInfiniteScrolling: true, dedupStrategy: 'none', sortOrder: 'Descending',
    },
  };
}

// Instant-query table helper: turns several PromQL expressions into one row per label set.
function instantTable(title, cols, o = {}) {
  const { w = 24, h = 8, by, description = '', sortBy = [] } = o;
  const targets = cols.map((c) => prom(c.expr, '', { instant: true, range: false, format: 'table' }));
  const renames = {};
  const units = [];
  cols.forEach((c, i) => {
    renames[`Value #${String.fromCharCode(65 + i)}`] = c.name;
    if (c.unit) units.push({ matcher: { id: 'byName', options: c.name }, properties: [{ id: 'unit', value: c.unit }, ...(c.decimals !== undefined ? [{ id: 'decimals', value: c.decimals }] : [])] });
  });
  const keep = Object.fromEntries([...by, ...cols.map((c) => c.name)].map((k) => [k, false]));
  return table(title, targets, {
    w, h, description, sortBy,
    overrides: units,
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: { Time: true }, renameByName: renames, indexByName: {} } },
      { id: 'filterFieldsByName', options: { include: { names: [...by, ...cols.map((c) => c.name)] } } },
    ],
  });
}

const T = {
  // Green below warn, orange to crit, red above.
  highIsBad: (warn, crit) => ({ mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: warn }, { color: 'red', value: crit }] }),
  // Red below crit, orange to warn, green above.
  lowIsBad: (crit, warn) => ({ mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: crit }, { color: 'green', value: warn }] }),
  upDown: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] },
};
const UP_MAPPINGS = [
  { type: 'value', options: { 0: { text: 'DOWN', color: 'red' }, 1: { text: 'UP', color: 'green' } } },
];

// Grafana Explore links. `${var:percentencode}` lets Grafana interpolate dashboard variables.
function exploreUrl(datasource, query) {
  const panes = { a: { datasource: datasource.uid, queries: [{ refId: 'A', datasource, ...query }], range: { from: 'now-1h', to: 'now' } } };
  let s = encodeURIComponent(JSON.stringify(panes));
  // Put template variables back so Grafana can interpolate them.
  s = s.replace(/%24%7B([a-z_]+)%3Apercentencode%7D/g, '${$1:percentencode}');
  return `/explore?schemaVersion=1&orgId=1&panes=${s}`;
}

function variable(name, query, o = {}) {
  const { label = name, multi = true, includeAll = true, allValue = '.+', datasource = DS.prom, regex = '', hide = 0, sort = 1 } = o;
  const q = datasource.type === 'loki'
    ? { label: query.label, stream: query.stream ?? '', type: 1, refId: 'LokiVariableQueryEditor-VariableQuery' }
    : { query, refId: 'PrometheusVariableQueryEditor-VariableQuery', qryType: 1 };
  return {
    name, label, type: 'query', datasource, query: q, definition: typeof query === 'string' ? query : '',
    refresh: 2, multi, includeAll, allValue, regex, hide, sort,
    current: includeAll ? { selected: true, text: ['All'], value: ['$__all'] } : {},
    options: [],
  };
}

function textbox(name, label, value = '') {
  return { name, label, type: 'textbox', query: value, current: { text: value, value }, hide: 0 };
}

function dashboard({ uid, title, tags = [], description = '', panels, vars = [], links = [], time = 'now-1h', refresh = '30s' }) {
  return {
    uid, title, description, tags: ['lab', ...tags], editable: false, graphTooltip: 1, timezone: 'browser',
    schemaVersion: 39, version: 1, refresh, time: { from: time, to: 'now' },
    timepicker: { refresh_intervals: ['10s', '30s', '1m', '5m', '15m'] },
    templating: { list: vars },
    annotations: { list: [{ builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' }] },
    links: [
      { title: 'Lab dashboards', type: 'dashboards', tags: ['lab'], asDropdown: true, includeVars: false, keepTime: true, icon: 'external link' },
      ...links,
    ],
    panels,
  };
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

// The app label for Traefik metrics is computed by recording rules in rules/lab.rules.yaml.
const APPS = [
  { app: 'home', title: 'Home', ns: 'home' },
  { app: 'auth', title: 'Auth (Authelia)', ns: 'auth' },
  { app: 'storage', title: 'Storage', ns: 'storage' },
  { app: 'todo', title: 'Todo', ns: 'todo' },
  { app: 'pdf', title: 'PDF (Stirling PDF)', ns: 'pdf' },
  { app: 'grafana', title: 'Grafana', ns: 'monitoring' },
];

// Up/rate/errors/p95 for one app from probes and Traefik metrics, plus a traffic graph.
function appTraefikRow(app, { trafficWidth = 8 } = {}) {
  const out = [];
  out.push(stat('Probe', [prom(`min(probe_success{app="${app}"})`)], { w: 2, h: 4, mappings: UP_MAPPINGS, thresholds: T.upDown, colorMode: 'background', noValue: 'no probe', description: 'Blackbox probe through the real ingress (SSO redirect or 200).' }));
  out.push(stat('Requests/s', [prom(`sum(app:traefik_requests:rate5m{app="${app}"})`)], { w: 3, h: 4, unit: 'reqps', decimals: 2, noValue: '0' }));
  out.push(stat('5xx ratio', [prom(`sum(app:traefik_requests_5xx:ratio_rate5m{app="${app}"})`)], { w: 3, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.01, 0.05), noValue: '0' }));
  out.push(stat('p95 latency', [prom(`max(app:traefik_request_duration_seconds:p95_5m{app="${app}"})`)], { w: 3, h: 4, unit: 's', decimals: 3, thresholds: T.highIsBad(0.5, 1), noValue: '-' }));
  out.push(stat('Cert expires', [prom(`min(probe_ssl_earliest_cert_expiry{app="${app}"}) - time()`)], { w: 3, h: 4, unit: 's', thresholds: T.lowIsBad(7 * 86400, 14 * 86400), noValue: '-' }));
  out.push(timeseries('Traffic by status', [prom(`sum by (code) (app_code:traefik_requests:rate5m{app="${app}"})`, '{{code}}')], { w: trafficWidth + 2, h: 4, unit: 'reqps', legend: 'hidden', stack: true, fill: 40 }));
  return out;
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

const boards = [];

// Lab overview -------------------------------------------------------------
resetLayout();
{
  const p = [];
  p.push(text('Every app at a glance. **Probe**: blackbox check through the ingress (an SSO app passes when it redirects to Authelia). Request rate, 5xx ratio and p95 come from Traefik\'s per-service metrics (`rules/lab.rules.yaml`). Deeper views: _Apps / HTTP RED_, _Storage_, _Todo_, _Platform_ folder, _Kubernetes_ folder.', { h: 2 }));
  p.push(row('Cluster'));
  p.push(stat('Firing alerts', [prom('count(ALERTS{alertstate="firing", alertname!~"Watchdog|InfoInhibitor"}) or vector(0)')], { w: 3, h: 4, thresholds: T.highIsBad(1, 3), colorMode: 'background' }));
  p.push(stat('Pods not ready', [prom('sum(kube_pod_status_ready{condition="false"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase=~"Running|Pending"} == 1)) or vector(0)')], { w: 3, h: 4, thresholds: T.highIsBad(1, 3), description: 'Running or Pending pods that are not Ready (finished Job pods excluded).' }));
  p.push(stat('Pods CPU', [prom('sum(rate(container_cpu_usage_seconds_total{container!="", pod!=""}[5m]))')], { w: 3, h: 4, unit: 'none', decimals: 2, description: 'CPU cores used by all containers.' }));
  p.push(stat('Pods memory', [prom('sum(container_memory_working_set_bytes{container!="", pod!=""})')], { w: 3, h: 4, unit: 'bytes', decimals: 1 }));
  p.push(gauge('Host CPU', [prom('1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))')], { w: 3, h: 4, thresholds: T.highIsBad(0.7, 0.9), description: 'kind nodes share the host kernel, so node-exporter reports the host.' }));
  p.push(gauge('Host memory', [prom('1 - avg(node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)')], { w: 3, h: 4, thresholds: T.highIsBad(0.8, 0.9) }));
  p.push(gauge('Host disk', [prom('1 - min(node_filesystem_avail_bytes{mountpoint=~"/|/var|/data", fstype!="tmpfs"} / node_filesystem_size_bytes{mountpoint=~"/|/var|/data", fstype!="tmpfs"})')], { w: 3, h: 4, thresholds: T.highIsBad(0.8, 0.9), description: 'Fullest of the host filesystems behind /var (images, PVCs) and /data (DATA_DIR).' }));
  p.push(stat('Targets down', [prom('count(up == 0) or vector(0)')], { w: 3, h: 4, thresholds: T.highIsBad(1, 1), description: 'Prometheus scrape targets that fail.' }));
  p.push(table('Active alerts', [prom('ALERTS{alertstate="firing", alertname!~"Watchdog|InfoInhibitor"}', '', { instant: true, range: false, format: 'table' })], {
    w: 12, h: 7,
    transformations: [{ id: 'organize', options: { excludeByName: { Time: true, Value: true, __name__: true, alertstate: true, prometheus: true, cluster: true, environment: true }, indexByName: { alertname: 0, severity: 1, app: 2, namespace: 3 } } }],
  }));
  p.push(timeseries('CPU by namespace', [prom('sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", pod!=""}[5m]))', '{{namespace}}')], { w: 6, h: 7, unit: 'none', stack: true, fill: 30, legend: 'hidden' }));
  p.push(timeseries('Memory by namespace', [prom('sum by (namespace) (container_memory_working_set_bytes{container!="", pod!=""})', '{{namespace}}')], { w: 6, h: 7, unit: 'bytes', stack: true, fill: 30, legend: 'hidden' }));
  for (const a of APPS) {
    p.push(row(a.title));
    p.push(...appTraefikRow(a.app));
  }
  p.push(row('Ingress totals'));
  p.push(timeseries('Requests by app', [prom('sum by (app) (app:traefik_requests:rate5m{app!=""})', '{{app}}')], { w: 12, h: 8, unit: 'reqps' }));
  p.push(timeseries('p95 latency by app', [prom('app:traefik_request_duration_seconds:p95_5m{app!="", app!="grafana"}', '{{app}}')], { w: 12, h: 8, unit: 's' }));
  boards.push(['lab', dashboard({ uid: 'lab-overview', title: 'Lab overview', tags: ['overview'], description: 'Up/down, traffic, errors and latency for every app, plus cluster health.', panels: p })]);
}

// Apps / HTTP RED ----------------------------------------------------------
resetLayout();
{
  const sel = 'namespace=~"$namespace", job=~"$job", route=~"$route"';
  const p = [];
  p.push(text('RED metrics from the apps\' own `http_server_request_duration_seconds` histogram and `http_server_active_requests` gauge (contract metrics; every app we write exports them on port 9464). Click a dot on the latency graph to open its trace (exemplar). Links above: traces and logs for the selected app.', { h: 2 }));
  p.push(stat('Requests/s', [prom(`sum(rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`)], { w: 4, h: 4, unit: 'reqps', decimals: 2 }));
  p.push(stat('5xx ratio', [prom(`sum(rate(http_server_request_duration_seconds_count{${sel}, status_code=~"5.."}[$__rate_interval])) / sum(rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`)], { w: 4, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.01, 0.05), noValue: '0' }));
  p.push(stat('4xx ratio', [prom(`sum(rate(http_server_request_duration_seconds_count{${sel}, status_code=~"4.."}[$__rate_interval])) / sum(rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`)], { w: 4, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.1, 0.3), noValue: '0' }));
  p.push(stat('p50', [prom(`histogram_quantile(0.5, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`)], { w: 4, h: 4, unit: 's', decimals: 3 }));
  p.push(stat('p95', [prom(`histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`)], { w: 4, h: 4, unit: 's', decimals: 3, thresholds: T.highIsBad(0.5, 1) }));
  p.push(stat('In flight', [prom('sum(http_server_active_requests{namespace=~"$namespace", job=~"$job"})')], { w: 4, h: 4 }));
  p.push(timeseries('Rate by route', [prom(`sum by (route) (rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`, '{{route}}')], { w: 12, unit: 'reqps', legend: 'table' }));
  p.push(timeseries('Errors (5xx) by route', [prom(`sum by (route, status_code) (rate(http_server_request_duration_seconds_count{${sel}, status_code=~"5.."}[$__rate_interval]))`, '{{route}} {{status_code}}')], { w: 12, unit: 'reqps', legend: 'table' }));
  p.push(timeseries('Latency (click a dot to open the trace)', [
    prom(`histogram_quantile(0.5, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`, 'p50'),
    prom(`histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`, 'p95', { exemplar: true }),
    prom(`histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`, 'p99'),
  ], { w: 12, unit: 's', description: 'Exemplars carry trace_id; clicking one opens the trace in Tempo.' }));
  p.push(timeseries('p95 by route', [prom(`histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`, '{{route}}')], { w: 12, unit: 's', legend: 'table' }));
  p.push(timeseries('Responses by status code', [prom(`sum by (status_code) (rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`, '{{status_code}}')], { w: 12, unit: 'reqps', stack: true, fill: 40 }));
  p.push(timeseries('Active requests', [prom('sum by (job) (http_server_active_requests{namespace=~"$namespace", job=~"$job"})', '{{job}}')], { w: 12 }));
  p.push(instantTable('Routes', [
    { name: 'req/s', expr: `sum by (job, route) (rate(http_server_request_duration_seconds_count{${sel}}[5m]))`, unit: 'reqps', decimals: 3 },
    { name: '5xx/s', expr: `sum by (job, route) (rate(http_server_request_duration_seconds_count{${sel}, status_code=~"5.."}[5m]))`, unit: 'reqps', decimals: 3 },
    { name: 'p95', expr: `histogram_quantile(0.95, sum by (job, route, le) (rate(http_server_request_duration_seconds_bucket{${sel}}[5m])))`, unit: 's', decimals: 3 },
  ], { by: ['job', 'route'], h: 9, sortBy: [{ displayName: 'req/s', desc: true }] }));
  p.push(row('Runtime'));
  p.push(timeseries('Resident memory', [prom('sum by (job, pod) (process_resident_memory_bytes{namespace=~"$namespace", job=~"$job"})', '{{pod}}')], { w: 8, unit: 'bytes' }));
  p.push(timeseries('CPU', [prom('sum by (job, pod) (rate(process_cpu_seconds_total{namespace=~"$namespace", job=~"$job"}[$__rate_interval]))', '{{pod}}')], { w: 8, unit: 'none' }));
  p.push(timeseries('Go goroutines / Node.js event loop lag', [
    prom('sum by (pod) (go_goroutines{namespace=~"$namespace", job=~"$job"})', '{{pod}} goroutines'),
    prom('max by (pod) (nodejs_eventloop_lag_p99_seconds{namespace=~"$namespace", job=~"$job"}) * 1000', '{{pod}} event loop p99 (ms)'),
  ], { w: 8 }));
  p.push(row('Logs'));
  p.push(logs('Warnings and errors', '{namespace=~"$namespace", app=~"$job"} | json | level=~"warn|error"', { h: 10 }));
  const tempoLink = exploreUrl(DS.tempo, { queryType: 'traceql', query: '{resource.service.name=~"${job:percentencode}"}', limit: 20 });
  const lokiLink = exploreUrl(DS.loki, { expr: '{namespace=~"${namespace:percentencode}", app=~"${job:percentencode}"}' });
  boards.push(['apps', dashboard({
    uid: 'apps-http-red', title: 'Apps / HTTP RED', tags: ['apps', 'red'], description: 'Rate, errors and duration for every app that exports the contract HTTP metrics.', panels: p,
    vars: [
      variable('namespace', 'label_values(http_server_request_duration_seconds_count, namespace)'),
      variable('job', 'label_values(http_server_request_duration_seconds_count{namespace=~"$namespace"}, job)'),
      variable('route', 'label_values(http_server_request_duration_seconds_count{namespace=~"$namespace", job=~"$job"}, route)'),
    ],
    links: [
      { title: 'Traces for this app (Tempo)', type: 'link', url: tempoLink, icon: 'external link', targetBlank: false, includeVars: false, keepTime: false },
      { title: 'Logs for this app (Loki)', type: 'link', url: lokiLink, icon: 'external link', targetBlank: false, includeVars: false, keepTime: false },
    ],
  })]);
}

// Shared bits for the storage and todo dashboards.
function appHttpSummary(ns) {
  const sel = `namespace="${ns}"`;
  return [
    stat('Probe', [prom(`min(probe_success{app="${ns}"})`)], { w: 3, h: 4, mappings: UP_MAPPINGS, thresholds: T.upDown, colorMode: 'background', noValue: 'no probe' }),
    stat('Requests/s', [prom(`sum(rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`)], { w: 3, h: 4, unit: 'reqps', decimals: 2, noValue: '0' }),
    stat('5xx ratio', [prom(`sum(rate(http_server_request_duration_seconds_count{${sel}, status_code=~"5.."}[$__rate_interval])) / sum(rate(http_server_request_duration_seconds_count{${sel}}[$__rate_interval]))`)], { w: 3, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.01, 0.05), noValue: '0' }),
    stat('p95', [prom(`histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{${sel}}[$__rate_interval])))`)], { w: 3, h: 4, unit: 's', decimals: 3, thresholds: T.highIsBad(0.5, 1) }),
    stat('SLO: 30d availability', [prom(`1 - (sum(increase(traefik_service_requests_total{exported_service=~"${ns}-.*", code=~"5.."}[7d])) or vector(0)) / sum(increase(traefik_service_requests_total{exported_service=~"${ns}-.*"}[7d]))`)], { w: 4, h: 4, unit: 'percentunit', decimals: 3, thresholds: T.lowIsBad(0.99, 0.995), description: 'Non-5xx share of requests at Traefik over the 7 days Prometheus keeps (target 99.5%).' }),
    stat('Error budget burn (1h)', [prom(`app:slo_errors:ratio_rate1h{app="${ns}"} / 0.005`)], { w: 4, h: 4, unit: 'x', decimals: 2, thresholds: T.highIsBad(1, 14.4), noValue: '0', description: '1 = spending the 0.5% budget exactly at the sustainable rate; 14.4 pages.' }),
    stat('Pods ready', [prom(`sum(kube_pod_status_ready{namespace="${ns}", condition="true"})`)], { w: 4, h: 4 }),
  ];
}
function dbRow(ns, cluster) {
  return [
    stat('Database', [prom(`min(cnpg_collector_up{namespace="${ns}"})`)], { w: 3, h: 4, mappings: UP_MAPPINGS, thresholds: T.upDown, colorMode: 'background', noValue: 'no data' }),
    stat('DB size', [prom(`sum(cnpg_pg_database_size_bytes{namespace="${ns}", datname="${ns}"})`)], { w: 3, h: 4, unit: 'bytes' }),
    stat('Connections', [prom(`sum(cnpg_backends_total{namespace="${ns}"})`)], { w: 3, h: 4 }),
    timeseries('Transactions/s', [prom(`sum(rate(cnpg_pg_stat_database_xact_commit{namespace="${ns}", datname="${ns}"}[$__rate_interval]))`, 'commits'), prom(`sum(rate(cnpg_pg_stat_database_xact_rollback{namespace="${ns}", datname="${ns}"}[$__rate_interval]))`, 'rollbacks')], { w: 15, h: 4, legend: 'hidden', unit: 'ops' }),
  ];
}

// Storage ------------------------------------------------------------------
resetLayout();
{
  const ns = 'storage';
  const p = [];
  p.push(text('Domain metrics of the storage app (`services/storage/METRICS.md`). HTTP details: _Apps / HTTP RED_ with job=storage.', { h: 2 }));
  p.push(...appHttpSummary(ns));
  p.push(row('Data'));
  p.push(stat('Files', [prom('max(storage_files)')], { w: 4, h: 4 }));
  p.push(stat('Stored (logical)', [prom('max(storage_used_bytes)')], { w: 4, h: 4, unit: 'bytes' }));
  p.push(stat('Volume free', [prom('max(storage_volume_free_bytes)')], { w: 4, h: 4, unit: 'bytes' }));
  p.push(gauge('Volume free %', [prom('max(storage_volume_free_bytes) / max(storage_volume_size_bytes)')], { w: 4, h: 4, thresholds: T.lowIsBad(0.1, 0.2) }));
  p.push(stat('User shares', [prom('max(storage_shares_active{type="user"})')], { w: 4, h: 4 }));
  p.push(stat('Public links', [prom('max(storage_shares_active{type="link"})')], { w: 4, h: 4 }));
  p.push(timeseries('Stored bytes and files', [prom('max(storage_used_bytes)', 'bytes stored'), prom('max(storage_files)', 'files')], {
    w: 12, overrides: [{ matcher: { id: 'byName', options: 'bytes stored' }, properties: [{ id: 'unit', value: 'bytes' }] }, { matcher: { id: 'byName', options: 'files' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] }],
  }));
  p.push(timeseries('Volume free', [prom('max(storage_volume_free_bytes)', 'free'), prom('max(storage_volume_size_bytes)', 'size')], { w: 12, unit: 'bytes' }));
  p.push(row('Transfers'));
  p.push(timeseries('Upload throughput', [prom('sum(rate(storage_upload_bytes_total[$__rate_interval]))', 'upload')], { w: 8, unit: 'Bps' }));
  p.push(timeseries('Download throughput by kind', [prom('sum by (kind) (rate(storage_download_bytes_total[$__rate_interval]))', '{{kind}}')], { w: 8, unit: 'Bps', stack: true, fill: 30 }));
  p.push(timeseries('Uploads by result', [prom('sum by (result) (rate(storage_uploads_total[$__rate_interval]))', '{{result}}')], { w: 8, unit: 'ops', stack: true, fill: 30 }));
  p.push(row('Viewer'));
  p.push(timeseries('Preview requests by kind', [prom('sum by (kind) (rate(storage_preview_requests_total[$__rate_interval]))', '{{kind}}')], { w: 8, unit: 'reqps', stack: true, fill: 30 }));
  p.push(timeseries('Thumbnail generation', [
    prom('histogram_quantile(0.5, sum by (le) (rate(storage_thumbnail_duration_seconds_bucket[$__rate_interval])))', 'p50'),
    prom('histogram_quantile(0.95, sum by (le) (rate(storage_thumbnail_duration_seconds_bucket[$__rate_interval])))', 'p95', { exemplar: true }),
  ], { w: 8, unit: 's' }));
  p.push(timeseries('Office to PDF (Stirling)', [
    prom('sum by (result) (rate(storage_office_conversions_total[$__rate_interval]))', '{{result}}'),
    prom('histogram_quantile(0.95, sum by (le) (rate(storage_office_conversion_duration_seconds_bucket[$__rate_interval])))', 'p95 duration'),
  ], { w: 8, overrides: [{ matcher: { id: 'byName', options: 'p95 duration' }, properties: [{ id: 'unit', value: 's' }, { id: 'custom.axisPlacement', value: 'right' }] }] }));
  p.push(row('Security'));
  p.push(timeseries('Public link password attempts', [prom('sum by (result) (rate(storage_link_unlock_attempts_total[$__rate_interval]))', '{{result}}')], { w: 8, unit: 'ops' }));
  p.push(timeseries('Refused request forgery', [prom('sum by (reason) (rate(storage_forgery_refused_total[$__rate_interval]))', '{{reason}}')], { w: 8, unit: 'ops' }));
  p.push(timeseries('Background cleanup', [prom('sum by (kind) (increase(storage_purged_total[1h]))', '{{kind}}')], { w: 8, bars: true, description: 'Items purged per hour.' }));
  p.push(row('Database (CloudNativePG storage-db)'));
  p.push(...dbRow(ns, 'storage-db'));
  p.push(row('Logs'));
  p.push(logs('Storage logs', '{namespace="storage", app="storage"} | json | line_format "{{.level}} {{.msg}} {{.method}} {{.route}} {{.status}} {{.user}}"', { h: 10, description: 'Share tokens are already redacted to {token} by Alloy.' }));
  boards.push(['apps', dashboard({ uid: 'storage', title: 'Storage', tags: ['apps', 'storage'], description: 'Storage app domain metrics, SLO and logs.', panels: p })]);
}

// Todo ---------------------------------------------------------------------
resetLayout();
{
  const ns = 'todo';
  const p = [];
  p.push(text('Domain metrics of the todo app (`services/todo/METRICS.md`). HTTP details: _Apps / HTTP RED_ with job=todo.', { h: 2 }));
  p.push(...appHttpSummary(ns));
  p.push(row('Tasks'));
  p.push(stat('Open tasks', [prom('max(todo_tasks_open)')], { w: 6, h: 4 }));
  p.push(stat('Projects', [prom('max(todo_projects)')], { w: 6, h: 4 }));
  p.push(stat('Live connections (SSE)', [prom('sum(todo_live_connections)')], { w: 6, h: 4 }));
  p.push(stat('Completed today', [prom('sum(increase(todo_tasks_completed_total[24h]))')], { w: 6, h: 4, decimals: 0 }));
  p.push(timeseries('Created vs completed (per minute)', [
    prom('sum(rate(todo_tasks_created_total[$__rate_interval])) * 60', 'created'),
    prom('sum(rate(todo_tasks_completed_total[$__rate_interval])) * 60', 'completed'),
  ], { w: 12 }));
  p.push(timeseries('Open tasks and projects', [prom('max(todo_tasks_open)', 'open tasks'), prom('max(todo_projects)', 'projects')], { w: 12 }));
  p.push(timeseries('Live connections', [prom('sum by (pod) (todo_live_connections)', '{{pod}}')], { w: 12 }));
  p.push(timeseries('Requests by route', [prom('sum by (route) (rate(http_server_request_duration_seconds_count{namespace="todo"}[$__rate_interval]))', '{{route}}')], { w: 12, unit: 'reqps' }));
  p.push(row('Database (CloudNativePG todo-db)'));
  p.push(...dbRow(ns, 'todo-db'));
  p.push(row('Logs'));
  p.push(logs('Todo logs', '{namespace="todo"} | json | line_format "{{.level}} {{.msg}} {{.method}} {{.route}} {{.status}} {{.user}}"', { h: 10 }));
  boards.push(['apps', dashboard({ uid: 'todo', title: 'Todo', tags: ['apps', 'todo'], description: 'Todo app domain metrics, SLO and logs.', panels: p })]);
}

// Traefik ------------------------------------------------------------------
resetLayout();
{
  const p = [];
  p.push(stat('Traefik up', [prom('min(up{job="traefik-metrics"})')], { w: 4, h: 4, mappings: UP_MAPPINGS, thresholds: T.upDown, colorMode: 'background' }));
  p.push(stat('Requests/s', [prom('sum(rate(traefik_entrypoint_requests_total[$__rate_interval]))')], { w: 4, h: 4, unit: 'reqps', decimals: 2 }));
  p.push(stat('5xx ratio', [prom('sum(rate(traefik_entrypoint_requests_total{code=~"5.."}[$__rate_interval])) / sum(rate(traefik_entrypoint_requests_total[$__rate_interval]))')], { w: 4, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.01, 0.05), noValue: '0' }));
  p.push(stat('Open connections', [prom('sum(traefik_open_connections)')], { w: 4, h: 4 }));
  p.push(stat('Config reloads (1h)', [prom('sum(increase(traefik_config_reloads_total[1h]))')], { w: 4, h: 4, decimals: 0 }));
  p.push(stat('Last config reload', [prom('time() - max(traefik_config_last_reload_success)')], { w: 4, h: 4, unit: 's' }));
  p.push(timeseries('Entry point requests by code', [prom('sum by (entrypoint, code) (rate(traefik_entrypoint_requests_total[$__rate_interval]))', '{{entrypoint}} {{code}}')], { w: 12, unit: 'reqps' }));
  p.push(timeseries('Entry point p95', [prom('histogram_quantile(0.95, sum by (le, entrypoint) (rate(traefik_entrypoint_request_duration_seconds_bucket[$__rate_interval])))', '{{entrypoint}}')], { w: 12, unit: 's' }));
  p.push(timeseries('Requests by service', [prom('sum by (exported_service) (rate(traefik_service_requests_total[$__rate_interval]))', '{{exported_service}}')], { w: 12, unit: 'reqps', legend: 'table' }));
  p.push(timeseries('p95 by service', [prom('histogram_quantile(0.95, sum by (le, exported_service) (rate(traefik_service_request_duration_seconds_bucket[$__rate_interval])))', '{{exported_service}}')], { w: 12, unit: 's', legend: 'table' }));
  p.push(timeseries('Requests by router', [prom('sum by (router) (rate(traefik_router_requests_total[$__rate_interval]))', '{{router}}')], { w: 12, unit: 'reqps', legend: 'table' }));
  p.push(timeseries('Open connections by entry point', [prom('sum by (entrypoint) (traefik_open_connections)', '{{entrypoint}}')], { w: 12 }));
  p.push(timeseries('Bytes in/out', [prom('sum(rate(traefik_entrypoint_requests_bytes_total[$__rate_interval]))', 'in'), prom('sum(rate(traefik_entrypoint_responses_bytes_total[$__rate_interval]))', 'out')], { w: 12, unit: 'Bps' }));
  p.push(timeseries('Traefik process', [prom('sum(process_resident_memory_bytes{job="traefik-metrics"})', 'memory'), prom('sum(rate(process_cpu_seconds_total{job="traefik-metrics"}[$__rate_interval]))', 'cpu')], {
    w: 12, unit: 'bytes', overrides: [{ matcher: { id: 'byName', options: 'cpu' }, properties: [{ id: 'unit', value: 'none' }, { id: 'custom.axisPlacement', value: 'right' }] }],
  }));
  p.push(row('Access logs'));
  p.push(timeseries('Access log lines by status', [loki('sum by (status) (count_over_time({namespace="traefik"} | json | DownstreamStatus=~".+" | label_format status=`{{ .DownstreamStatus }}` [$__auto]))', { legendFormat: '{{status}}' })], { w: 24, h: 6, datasource: DS.loki, bars: true, stack: true }));
  p.push(logs('Access log (paths are not logged: they can carry share tokens)', '{namespace="traefik"} | json | DownstreamStatus=~".+" | line_format "{{.DownstreamStatus}} {{.RequestMethod}} {{.RequestHost}} {{.RouterName}} {{.Duration}}"', { h: 10 }));
  p.push(logs('Errors', '{namespace="traefik"} | json | level=~"error|warn"', { h: 8 }));
  boards.push(['platform', dashboard({ uid: 'traefik', title: 'Traefik', tags: ['platform', 'ingress'], description: 'Ingress traffic, latency, connections and access logs.', panels: p })]);
}

// Authelia -----------------------------------------------------------------
resetLayout();
{
  const p = [];
  p.push(...appTraefikRow('auth', { trafficWidth: 8 }));
  p.push(row('Authelia metrics'));
  p.push(timeseries('Forward-auth decisions by code', [prom('sum by (code) (rate(authelia_authz[$__rate_interval]))', '{{code}}')], { w: 12, unit: 'reqps', description: 'Every request to an SSO route asks Authelia first: 200 allowed, 302/303 sent to the portal, 401/403 refused.' }));
  p.push(timeseries('Portal and API requests by code', [prom('sum by (code, method) (rate(authelia_request[$__rate_interval]))', '{{method}} {{code}}')], { w: 12, unit: 'reqps' }));
  p.push(timeseries('First-factor logins (per 5 min)', [prom('sum by (success, banned) (increase(authelia_authn[5m]))', 'success={{success}} banned={{banned}}')], { w: 12, bars: true }));
  p.push(timeseries('Latency p95', [prom('histogram_quantile(0.95, sum by (le) (rate(authelia_request_duration_bucket[$__rate_interval])))', 'requests'), prom('histogram_quantile(0.95, sum by (le) (rate(authelia_authn_duration_bucket[$__rate_interval])))', 'login (argon2id)')], { w: 12, unit: 's' }));
  p.push(timeseries('Process', [prom('sum(process_resident_memory_bytes{namespace="auth"})', 'memory'), prom('sum(go_goroutines{namespace="auth"})', 'goroutines')], {
    w: 12, unit: 'bytes', overrides: [{ matcher: { id: 'byName', options: 'goroutines' }, properties: [{ id: 'unit', value: 'short' }, { id: 'custom.axisPlacement', value: 'right' }] }],
  }));
  p.push(row('Logs'));
  p.push(timeseries('Log lines by level', [loki('sum by (level) (count_over_time({namespace="auth"} [$__auto]))', { legendFormat: '{{level}}' })], { w: 24, h: 6, datasource: DS.loki, bars: true, stack: true }));
  p.push(logs('Failed or banned logins', '{namespace="auth"} |~ "(?i)unsuccessful|banned|failed|regulation"', { h: 8 }));
  p.push(logs('All Authelia logs', '{namespace="auth"}', { h: 10 }));
  boards.push(['platform', dashboard({ uid: 'authelia', title: 'Authelia', tags: ['platform', 'auth'], description: 'Single sign-on: availability, forward-auth decisions, logins and logs.', panels: p })]);
}

// Stirling PDF -------------------------------------------------------------
resetLayout();
{
  const p = [];
  p.push(text('Stirling PDF exposes no Prometheus metrics without a paid licence (`/actuator/prometheus` answers 404), so it is covered by Traefik service metrics, the blackbox probe, container metrics and its logs. Conversions the storage app requests also show on the _Storage_ dashboard (Office to PDF).', { h: 2 }));
  p.push(...appTraefikRow('pdf', { trafficWidth: 8 }));
  p.push(timeseries('Requests by status', [prom('sum by (code) (app_code:traefik_requests:rate5m{app="pdf"})', '{{code}}')], { w: 12, unit: 'reqps', stack: true, fill: 30 }));
  p.push(timeseries('Latency at Traefik', [
    prom('histogram_quantile(0.5, sum by (le) (app_le:traefik_request_duration_seconds_bucket:rate5m{app="pdf"}))', 'p50'),
    prom('histogram_quantile(0.95, sum by (le) (app_le:traefik_request_duration_seconds_bucket:rate5m{app="pdf"}))', 'p95'),
  ], { w: 12, unit: 's' }));
  p.push(timeseries('Container CPU', [prom('sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="pdf", container!=""}[$__rate_interval]))', '{{pod}}')], { w: 8, unit: 'none' }));
  p.push(timeseries('Container memory', [prom('sum by (pod) (container_memory_working_set_bytes{namespace="pdf", container!=""})', '{{pod}}'), prom('max(kube_pod_container_resource_limits{namespace="pdf", resource="memory"})', 'limit')], { w: 8, unit: 'bytes' }));
  p.push(timeseries('Restarts', [prom('sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="pdf"}[1h]))', '{{pod}}')], { w: 8, bars: true }));
  p.push(row('Logs'));
  p.push(timeseries('Log lines by level', [loki('sum by (level) (count_over_time({namespace="pdf"} [$__auto]))', { legendFormat: '{{level}}' })], { w: 24, h: 6, datasource: DS.loki, bars: true, stack: true }));
  p.push(logs('Warnings and errors', '{namespace="pdf"} |~ "(?i)\\\\b(warn|error|exception)\\\\b"', { h: 8 }));
  p.push(logs('All Stirling PDF logs', '{namespace="pdf"}', { h: 10 }));
  boards.push(['platform', dashboard({ uid: 'stirling-pdf', title: 'Stirling PDF', tags: ['platform', 'pdf'], description: 'Stirling PDF from the outside: Traefik metrics, probe, containers and logs.', panels: p })]);
}

// PostgreSQL (CloudNativePG) -----------------------------------------------
resetLayout();
{
  const sel = 'namespace=~"$namespace", cluster=~"$cluster"';
  const p = [];
  p.push(text('Every CloudNativePG `Cluster` in namespaces storage and todo, scraped by the PodMonitor `monitoring/cnpg-clusters` (exporter port 9187).', { h: 2 }));
  p.push(stat('Instances up', [prom(`sum(cnpg_collector_up{${sel}})`)], { w: 4, h: 4, thresholds: T.lowIsBad(1, 1) }));
  p.push(stat('Primary', [prom(`count(cnpg_pg_replication_in_recovery{${sel}} == 0)`)], { w: 4, h: 4 }));
  p.push(stat('Database size', [prom(`sum(cnpg_pg_database_size_bytes{${sel}, datname!~"template.*|postgres"})`)], { w: 4, h: 4, unit: 'bytes' }));
  p.push(stat('Connections', [prom(`sum(cnpg_backends_total{${sel}})`)], { w: 4, h: 4 }));
  p.push(stat('Max connections used', [prom(`max(sum by (pod) (cnpg_backends_total{${sel}}) / on (pod) group_left max by (pod) (cnpg_pg_settings_setting{${sel}, name="max_connections"}))`)], { w: 4, h: 4, unit: 'percentunit', thresholds: T.highIsBad(0.7, 0.9) }));
  p.push(stat('Collection errors', [prom(`sum(cnpg_collector_last_collection_error{${sel}})`)], { w: 4, h: 4, thresholds: T.highIsBad(1, 1) }));
  p.push(timeseries('Transactions/s', [prom(`sum by (cluster) (rate(cnpg_pg_stat_database_xact_commit{${sel}}[$__rate_interval]))`, '{{cluster}} commit'), prom(`sum by (cluster) (rate(cnpg_pg_stat_database_xact_rollback{${sel}}[$__rate_interval]))`, '{{cluster}} rollback')], { w: 12, unit: 'ops' }));
  p.push(timeseries('Connections by state', [prom(`sum by (cluster, state) (cnpg_backends_total{${sel}})`, '{{cluster}} {{state}}')], { w: 12, stack: true, fill: 30 }));
  p.push(timeseries('Rows', [
    prom(`sum by (cluster) (rate(cnpg_pg_stat_database_tup_inserted{${sel}}[$__rate_interval]))`, '{{cluster}} inserted'),
    prom(`sum by (cluster) (rate(cnpg_pg_stat_database_tup_updated{${sel}}[$__rate_interval]))`, '{{cluster}} updated'),
    prom(`sum by (cluster) (rate(cnpg_pg_stat_database_tup_deleted{${sel}}[$__rate_interval]))`, '{{cluster}} deleted'),
    prom(`sum by (cluster) (rate(cnpg_pg_stat_database_tup_fetched{${sel}}[$__rate_interval]))`, '{{cluster}} fetched'),
  ], { w: 12, unit: 'ops' }));
  p.push(timeseries('Cache hit ratio', [prom(`sum by (cluster) (rate(cnpg_pg_stat_database_blks_hit{${sel}}[$__rate_interval])) / (sum by (cluster) (rate(cnpg_pg_stat_database_blks_hit{${sel}}[$__rate_interval])) + sum by (cluster) (rate(cnpg_pg_stat_database_blks_read{${sel}}[$__rate_interval])))`, '{{cluster}}')], { w: 12, unit: 'percentunit', max: 1 }));
  p.push(timeseries('Database size', [prom(`sum by (cluster, datname) (cnpg_pg_database_size_bytes{${sel}, datname!~"template.*"})`, '{{cluster}} {{datname}}')], { w: 12, unit: 'bytes' }));
  p.push(timeseries('Deadlocks and conflicts', [prom(`sum by (cluster) (increase(cnpg_pg_stat_database_deadlocks{${sel}}[$__rate_interval]))`, '{{cluster}} deadlocks'), prom(`sum by (cluster) (increase(cnpg_pg_stat_database_conflicts{${sel}}[$__rate_interval]))`, '{{cluster}} conflicts')], { w: 12 }));
  p.push(timeseries('WAL files', [prom(`sum by (cluster) (cnpg_collector_pg_wal{${sel}, value="count"})`, '{{cluster}}')], { w: 12 }));
  p.push(timeseries('Last archived / last backup age', [prom(`time() - max by (cluster) (cnpg_pg_stat_archiver_last_archived_time{${sel}})`, '{{cluster}} WAL archive'), prom(`time() - max by (cluster) (cnpg_collector_last_available_backup_timestamp{${sel}})`, '{{cluster}} backup')], { w: 12, unit: 's', description: 'Logical pg_dump backups (CronJob <app>-db-backup) are not visible here; see the Kubernetes job metrics.' }));
  p.push(timeseries('Backup CronJob last success', [prom('time() - max by (namespace, cronjob) (kube_cronjob_status_last_successful_time{cronjob=~".*-db-backup"})', '{{namespace}}/{{cronjob}}')], { w: 12, unit: 's' }));
  p.push(timeseries('Instance memory', [prom(`sum by (pod) (container_memory_working_set_bytes{namespace=~"$namespace", pod=~"$cluster-[0-9]+", container="postgres"})`, '{{pod}}')], { w: 12, unit: 'bytes' }));
  p.push(row('Logs'));
  p.push(logs('PostgreSQL logs (errors and warnings)', '{namespace=~"$namespace", container="postgres"} | json | level=~"error|warn" or record_error_severity=~"ERROR|FATAL|PANIC|WARNING"', { h: 10 }));
  boards.push(['platform', dashboard({
    uid: 'postgresql', title: 'PostgreSQL (CloudNativePG)', tags: ['platform', 'database'], description: 'CloudNativePG clusters of the apps.', panels: p,
    vars: [
      variable('namespace', 'label_values(cnpg_collector_up, namespace)'),
      variable('cluster', 'label_values(cnpg_collector_up{namespace=~"$namespace"}, cluster)'),
    ],
  })]);
}

// Load tests (k6) ----------------------------------------------------------
resetLayout();
{
  const sel = 'testid=~"$testid"';
  // The live-update stream (`kind="stream"`) is held open on purpose, so it would set every
  // headline latency. It still shows in "p95 by request name".
  const dur = `${sel}, kind!="stream"`;
  const p = [];
  p.push(text('k6 runs with `--out experimental-prometheus-rw` to `http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write`, tagged `testid`. Trend metrics need `K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(95),p(99),avg,max` (k6 only sends p99 by default); see the README.', { h: 2 }));
  p.push(stat('VUs', [prom(`sum(k6_vus{${sel}})`)], { w: 4, h: 4 }));
  p.push(stat('Requests/s', [prom(`sum(rate(k6_http_reqs_total{${sel}}[$__rate_interval]))`)], { w: 4, h: 4, unit: 'reqps', decimals: 1 }));
  p.push(stat('Requests (range)', [prom(`sum(increase(k6_http_reqs_total{${sel}}[$__range]))`)], { w: 4, h: 4, decimals: 0 }));
  p.push(stat('Failed requests', [prom(`avg(k6_http_req_failed_rate{${sel}})`)], { w: 4, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.highIsBad(0.01, 0.05) }));
  p.push(stat('Checks passed', [prom(`avg(k6_checks_rate{${sel}})`)], { w: 4, h: 4, unit: 'percentunit', decimals: 2, thresholds: T.lowIsBad(0.95, 0.99) }));
  p.push(stat('p95 duration (no streams)', [prom(`max(k6_http_req_duration_p95{${dur}})`)], { w: 4, h: 4, unit: 's', decimals: 3, thresholds: T.highIsBad(0.5, 1) }));
  p.push(timeseries('VUs and request rate', [prom(`sum(k6_vus{${sel}})`, 'VUs'), prom(`sum(rate(k6_http_reqs_total{${sel}}[$__rate_interval]))`, 'req/s')], {
    w: 12, overrides: [{ matcher: { id: 'byName', options: 'req/s' }, properties: [{ id: 'unit', value: 'reqps' }, { id: 'custom.axisPlacement', value: 'right' }] }],
  }));
  p.push(timeseries('Request duration', [
    prom(`max(k6_http_req_duration_p50{${dur}})`, 'p50'),
    prom(`max(k6_http_req_duration_p90{${dur}})`, 'p90'),
    prom(`max(k6_http_req_duration_p95{${dur}})`, 'p95'),
    prom(`max(k6_http_req_duration_p99{${dur}})`, 'p99'),
    prom(`max(k6_http_req_duration_avg{${dur}})`, 'avg'),
  ], { w: 12, unit: 's' }));
  p.push(timeseries('Requests by status', [prom(`sum by (status) (rate(k6_http_reqs_total{${sel}}[$__rate_interval]))`, '{{status}}')], { w: 12, unit: 'reqps', stack: true, fill: 30 }));
  p.push(timeseries('Failure and check rates', [prom(`avg by (testid) (k6_http_req_failed_rate{${sel}})`, '{{testid}} failed'), prom(`avg by (testid) (k6_checks_rate{${sel}})`, '{{testid}} checks passed')], { w: 12, unit: 'percentunit', max: 1 }));
  p.push(timeseries('p95 by request name', [prom(`max by (name) (k6_http_req_duration_p95{${sel}})`, '{{name}}')], { w: 12, unit: 's', legend: 'table' }));
  p.push(timeseries('Requests by scenario', [prom(`sum by (scenario) (rate(k6_http_reqs_total{${sel}}[$__rate_interval]))`, '{{scenario}}')], { w: 12, unit: 'reqps' }));
  p.push(timeseries('Iterations', [prom(`sum(rate(k6_iterations_total{${sel}}[$__rate_interval]))`, 'iterations/s'), prom(`max(k6_iteration_duration_p95{${sel}})`, 'iteration p95')], {
    w: 12, overrides: [{ matcher: { id: 'byName', options: 'iteration p95' }, properties: [{ id: 'unit', value: 's' }, { id: 'custom.axisPlacement', value: 'right' }] }],
  }));
  p.push(timeseries('Data', [prom(`sum(rate(k6_data_sent_total{${sel}}[$__rate_interval]))`, 'sent'), prom(`sum(rate(k6_data_received_total{${sel}}[$__rate_interval]))`, 'received')], { w: 12, unit: 'Bps' }));
  p.push(timeseries('Connection phases p95', [
    prom(`max(k6_http_req_connecting_p95{${sel}})`, 'connecting'),
    prom(`max(k6_http_req_tls_handshaking_p95{${sel}})`, 'TLS'),
    prom(`max(k6_http_req_waiting_p95{${sel}})`, 'waiting (TTFB)'),
    prom(`max(k6_http_req_receiving_p95{${sel}})`, 'receiving'),
  ], { w: 12, unit: 's' }));
  p.push(row('Apps under load'));
  p.push(timeseries('App request rate at Traefik', [prom('sum by (app) (app:traefik_requests:rate5m{app!=""})', '{{app}}')], { w: 12, unit: 'reqps' }));
  p.push(timeseries('App p95 at Traefik', [prom('app:traefik_request_duration_seconds:p95_5m{app!="", app!="grafana"}', '{{app}}')], { w: 12, unit: 's' }));
  boards.push(['load-tests', dashboard({
    uid: 'k6', title: 'Load tests (k6)', tags: ['load-tests', 'k6'], description: 'k6 results via Prometheus remote write, per testid.', panels: p, time: 'now-30m', refresh: '10s',
    vars: [variable('testid', 'label_values(k6_vus, testid)', { label: 'Test ID' })],
  })]);
}

// Logs explorer ------------------------------------------------------------
resetLayout();
{
  const sel = '{namespace=~"$namespace", app=~"$app", level=~"$level"}';
  const p = [];
  p.push(text('Every pod\'s stdout/stderr and Kubernetes events (app=`kubernetes-events`), shipped by Alloy. Labels: `namespace`, `pod`, `container`, `app` (from `app.kubernetes.io/name`), `level` (JSON lines with a `level` key). Share tokens are already replaced with `{token}`. Lines with a `trace_id` (or Traefik `TraceId`) link to Tempo.', { h: 2 }));
  p.push(timeseries('Volume by level', [loki(`sum by (level) (count_over_time(${sel} |~ "$search" [$__auto]))`, { legendFormat: '{{level}}' })], { w: 12, h: 7, datasource: DS.loki, bars: true, stack: true, overrides: [
    { matcher: { id: 'byName', options: 'error' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }] },
    { matcher: { id: 'byName', options: 'warn' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } }] },
    { matcher: { id: 'byName', options: 'info' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'green' } }] },
  ] }));
  p.push(timeseries('Volume by app', [loki(`sum by (app) (count_over_time(${sel} |~ "$search" [$__auto]))`, { legendFormat: '{{app}}' })], { w: 12, h: 7, datasource: DS.loki, bars: true, stack: true }));
  p.push(logs('Logs', `${sel} |~ "$search"`, { h: 16 }));
  p.push(row('Kubernetes events'));
  p.push(logs('Warning events', '{app="kubernetes-events", namespace=~"$namespace"} |= "Warning"', { h: 8 }));
  boards.push(['lab', dashboard({
    uid: 'logs-explorer', title: 'Logs explorer', tags: ['logs'], description: 'Search every log line by namespace, app and level.', panels: p, refresh: '',
    vars: [
      variable('namespace', { label: 'namespace' }, { datasource: DS.loki }),
      variable('app', { label: 'app', stream: '{namespace=~"$namespace"}' }, { datasource: DS.loki }),
      { name: 'level', label: 'level', type: 'custom', query: 'debug,info,warn,error', multi: true, includeAll: true, allValue: '.*', current: { selected: true, text: ['All'], value: ['$__all'] }, options: [], hide: 0 },
      textbox('search', 'search (regex)'),
    ],
  })]);
}

// Traces -------------------------------------------------------------------
resetLayout();
{
  const p = [];
  p.push(text('Traces come from Traefik (every request through the ingress), Grafana and the apps, through Alloy into Tempo. Tempo\'s metrics generator turns spans into `traces_spanmetrics_*` and `traces_service_graph_*` series in Prometheus. Open a trace, then **Logs for this span** to see the matching log lines in Loki.', { h: 2 }));
  p.push({
    id: nextId++, type: 'nodeGraph', title: 'Service graph', datasource: DS.tempo, gridPos: place(24, 11),
    targets: [{ refId: 'A', datasource: DS.tempo, queryType: 'serviceMap', serviceMapQuery: '' }],
    options: { nodes: {}, edges: {} },
  });
  p.push(timeseries('Spans/s by service', [prom('sum by (service) (rate(traces_spanmetrics_calls_total{service=~"$service"}[$__rate_interval]))', '{{service}}')], { w: 8, unit: 'ops' }));
  p.push(timeseries('Error spans/s by service', [prom('sum by (service) (rate(traces_spanmetrics_calls_total{service=~"$service", status_code="STATUS_CODE_ERROR"}[$__rate_interval]))', '{{service}}')], { w: 8, unit: 'ops' }));
  p.push(timeseries('p95 span duration by service', [prom('histogram_quantile(0.95, sum by (le, service) (rate(traces_spanmetrics_latency_bucket{service=~"$service"}[$__rate_interval])))', '{{service}}', { exemplar: true })], { w: 8, unit: 's' }));
  p.push(instantTable('Spans', [
    { name: 'spans/s', expr: 'sum by (service, span_name, span_kind) (rate(traces_spanmetrics_calls_total{service=~"$service"}[5m]))', unit: 'ops', decimals: 3 },
    { name: 'errors/s', expr: 'sum by (service, span_name, span_kind) (rate(traces_spanmetrics_calls_total{service=~"$service", status_code="STATUS_CODE_ERROR"}[5m]))', unit: 'ops', decimals: 3 },
    { name: 'p95', expr: 'histogram_quantile(0.95, sum by (service, span_name, span_kind, le) (rate(traces_spanmetrics_latency_bucket{service=~"$service"}[5m])))', unit: 's', decimals: 3 },
  ], { by: ['service', 'span_name', 'span_kind'], h: 9, sortBy: [{ displayName: 'spans/s', desc: true }] }));
  p.push(timeseries('Service graph edges (requests/s)', [prom('sum by (client, server) (rate(traces_service_graph_request_total[$__rate_interval]))', '{{client}} → {{server}}')], { w: 12, unit: 'reqps' }));
  p.push(timeseries('Service graph failed edges', [prom('sum by (client, server) (rate(traces_service_graph_request_failed_total[$__rate_interval]))', '{{client}} → {{server}}')], { w: 12, unit: 'reqps' }));
  p.push(table('Recent traces', [{ datasource: DS.tempo, queryType: 'traceql', query: '{resource.service.name=~"$service"}', limit: 25, tableType: 'traces' }], { datasource: DS.tempo, h: 10 }));
  p.push(table('Slow traces (> 500 ms)', [{ datasource: DS.tempo, queryType: 'traceql', query: '{resource.service.name=~"$service" && duration > 500ms}', limit: 25, tableType: 'traces' }], { datasource: DS.tempo, h: 10 }));
  boards.push(['lab', dashboard({
    uid: 'traces', title: 'Traces', tags: ['traces'], description: 'Tempo service graph, span metrics and trace search.', panels: p,
    vars: [variable('service', 'label_values(traces_spanmetrics_calls_total, service)')],
  })]);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

for (const folder of ['lab', 'apps', 'platform', 'load-tests']) {
  const dir = join(HERE, folder);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
}
for (const [folder, d] of boards) {
  const file = join(HERE, folder, `${d.uid}.json`);
  writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  console.log(`wrote ${folder}/${d.uid}.json (${d.panels.length} panels)`);
}
