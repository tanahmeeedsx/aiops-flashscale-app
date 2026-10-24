import Fastify from 'fastify';
import Redis from 'ioredis';
import underPressure from '@fastify/under-pressure';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const PRODUCT_COUNT = Number(process.env.PRODUCT_COUNT || 100);
const redis = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });

const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });

const products = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
  id: `product-${i + 1}`,
  name: `FlashScale Product ${i + 1}`,
  price: Number((10 + (i % 50) * 1.25).toFixed(2)),
  stock: 1000 + i,
  category: ['cloud', 'devops', 'observability', 'security'][i % 4]
}));

function log(obj) {
  process.stdout.write(JSON.stringify({ source: 'api', timestamp: new Date().toISOString(), ...obj }) + '\n');
}

function nowMs() {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AIOPS_DEFAULT_CONFIG = {
  name: 'normal',
  label: 'Normal Operations',
  enabled: false,
  latencyMs: 0,
  errorRate: 0,
  workerDelayMs: Number(process.env.ORDER_PROCESSING_MS || 25),
  logAnomaly: false,
  description: 'Baseline mode. No artificial incidents are active.',
  expiresAt: null
};

const AIOPS_SCENARIOS = {
  normal: AIOPS_DEFAULT_CONFIG,
  latency: {
    name: 'latency',
    label: 'Latency Anomaly',
    enabled: true,
    latencyMs: 450,
    errorRate: 0,
    workerDelayMs: Number(process.env.ORDER_PROCESSING_MS || 25),
    logAnomaly: false,
    description: 'Adds artificial API latency so students can detect p95 latency anomalies.',
    ttlSeconds: Number(process.env.AIOPS_SCENARIO_TTL_SECONDS || 900)
  },
  'error-spike': {
    name: 'error-spike',
    label: '5xx Error Spike',
    enabled: true,
    latencyMs: 80,
    errorRate: 0.20,
    workerDelayMs: Number(process.env.ORDER_PROCESSING_MS || 25),
    logAnomaly: true,
    description: 'Injects controlled 503 responses to teach error-rate detection and alerting.',
    ttlSeconds: Number(process.env.AIOPS_SCENARIO_TTL_SECONDS || 900)
  },
  'worker-bottleneck': {
    name: 'worker-bottleneck',
    label: 'Worker Bottleneck',
    enabled: true,
    latencyMs: 0,
    errorRate: 0,
    workerDelayMs: 650,
    logAnomaly: true,
    description: 'Slows background processing so queue depth rises while the API may still look healthy.',
    ttlSeconds: Number(process.env.AIOPS_SCENARIO_TTL_SECONDS || 900)
  },
  'queue-backlog': {
    name: 'queue-backlog',
    label: 'Queue Backlog',
    enabled: true,
    latencyMs: 120,
    errorRate: 0.05,
    workerDelayMs: 1000,
    logAnomaly: true,
    description: 'Creates a backlog pattern by accepting orders faster than the worker can process them.',
    ttlSeconds: Number(process.env.AIOPS_SCENARIO_TTL_SECONDS || 900)
  },
  'log-anomaly': {
    name: 'log-anomaly',
    label: 'Log Anomaly',
    enabled: true,
    latencyMs: 0,
    errorRate: 0,
    workerDelayMs: Number(process.env.ORDER_PROCESSING_MS || 25),
    logAnomaly: true,
    description: 'Emits unusual structured log events for CloudWatch Logs investigations.',
    ttlSeconds: Number(process.env.AIOPS_SCENARIO_TTL_SECONDS || 900)
  }
};

let cachedAiopsConfig = { loadedAt: 0, value: AIOPS_DEFAULT_CONFIG };

async function getAiopsConfig() {
  const current = Date.now();
  if (current - cachedAiopsConfig.loadedAt < 1500) return cachedAiopsConfig.value;

  try {
    const raw = await redis.get('aiops:config');
    if (!raw) {
      cachedAiopsConfig = { loadedAt: current, value: AIOPS_DEFAULT_CONFIG };
      return cachedAiopsConfig.value;
    }
    const parsed = JSON.parse(raw);
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= current) {
      await redis.del('aiops:config');
      await redis.set('aiops:worker_delay_ms', String(AIOPS_DEFAULT_CONFIG.workerDelayMs));
      cachedAiopsConfig = { loadedAt: current, value: AIOPS_DEFAULT_CONFIG };
      return cachedAiopsConfig.value;
    }
    cachedAiopsConfig = { loadedAt: current, value: { ...AIOPS_DEFAULT_CONFIG, ...parsed } };
    return cachedAiopsConfig.value;
  } catch (err) {
    log({ event_type: 'aiops_config_error', message: err.message });
    return AIOPS_DEFAULT_CONFIG;
  }
}

function buildScenarioConfig(name) {
  const preset = AIOPS_SCENARIOS[name];
  if (!preset) return null;
  if (name === 'normal') return { ...AIOPS_DEFAULT_CONFIG };
  const ttlSeconds = Number(preset.ttlSeconds || process.env.AIOPS_SCENARIO_TTL_SECONDS || 900);
  return {
    ...preset,
    activatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    ttlSeconds
  };
}

function shouldSkipAiopsInjection(request) {
  return request.url === '/' || request.url.startsWith('/aiops') || request.url.startsWith('/health') || request.url.startsWith('/stats');
}

app.register(underPressure, {
  maxEventLoopDelay: 1000,
  maxHeapUsedBytes: 512 * 1024 * 1024,
  maxRssBytes: 768 * 1024 * 1024,
  message: 'Service under pressure',
  retryAfter: 5
});


app.addHook('preHandler', async (request, reply) => {
  if (shouldSkipAiopsInjection(request)) return;

  const config = await getAiopsConfig();
  if (!config.enabled) return;

  if (config.logAnomaly && Math.random() < 0.04) {
    log({
      event_type: 'aiops_log_anomaly',
      scenario: config.name,
      symptom: 'unusual_runtime_pattern',
      message: `AIOps lab anomaly marker for ${config.label}`
    });
  }

  if (Number(config.latencyMs || 0) > 0) {
    const jitter = Math.floor(Math.random() * 120);
    await sleep(Number(config.latencyMs) + jitter);
    log({ event_type: 'aiops_injected_latency', scenario: config.name, latency_ms: Number(config.latencyMs) + jitter });
  }

  if (Number(config.errorRate || 0) > 0 && Math.random() < Number(config.errorRate)) {
    log({ event_type: 'aiops_injected_error', scenario: config.name, status_code: 503, message: 'Controlled AIOps lab 5xx error' });
    reply.code(503);
    return reply.send({
      error: 'AIOps simulated server pressure',
      scenario: config.name,
      hint: 'This is a controlled lab incident. Reset from /aiops or POST /aiops/scenarios/normal.'
    });
  }
});

app.addHook('onRequest', async (request) => { request.startTimeMs = nowMs(); });

app.addHook('onResponse', async (request, reply) => {
  const latencyMs = Math.max(0, nowMs() - request.startTimeMs);
  log({
    event_type: 'request',
    request_id: request.id,
    method: request.method,
    route: request.routeOptions?.url || request.url,
    url: request.url,
    status_code: reply.statusCode,
    latency_ms: Number(latencyMs.toFixed(2)),
    user_agent: request.headers['user-agent'] || '',
    remote_addr: request.ip
  });
});

app.get('/health', async () => {
  const pong = await redis.ping();
  return { status: 'ok', redis: pong, timestamp: new Date().toISOString() };
});

app.get('/products', async (request, reply) => {
  reply.header('Cache-Control', 'public, max-age=10');
  return { items: products, count: products.length };
});

app.get('/products/:id', async (request, reply) => {
  const found = products.find((p) => p.id === request.params.id);
  if (!found) {
    reply.code(404);
    return { error: 'Product not found' };
  }
  return found;
});

app.post('/orders', async (request, reply) => {
  const body = request.body || {};
  const productId = body.productId || 'product-1';
  const quantity = Math.max(1, Number(body.quantity || 1));
  const order = { id: crypto.randomUUID(), productId, quantity, status: 'accepted', acceptedAt: new Date().toISOString() };
  await redis.lpush('orders:queue', JSON.stringify(order));
  await redis.incr('orders:accepted');
  log({ event_type: 'order_accepted', order_id: order.id, product_id: productId, quantity });
  reply.code(202);
  return order;
});

app.get('/stats', async () => {
  const [queueDepth, accepted, processed] = await Promise.all([
    redis.llen('orders:queue'),
    redis.get('orders:accepted'),
    redis.get('orders:processed')
  ]);
  return { queueDepth, accepted: Number(accepted || 0), processed: Number(processed || 0), products: products.length };
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function titleCase(value) {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}


async function readAiopsStatus() {
  const config = await getAiopsConfig();
  const [queueDepth, accepted, processed] = await Promise.all([
    redis.llen('orders:queue'),
    redis.get('orders:accepted'),
    redis.get('orders:processed')
  ]);

  return {
    mode: config.name,
    label: config.label,
    enabled: Boolean(config.enabled),
    description: config.description,
    latencyMs: Number(config.latencyMs || 0),
    errorRate: Number(config.errorRate || 0),
    workerDelayMs: Number(config.workerDelayMs || AIOPS_DEFAULT_CONFIG.workerDelayMs),
    logAnomaly: Boolean(config.logAnomaly),
    activatedAt: config.activatedAt || null,
    expiresAt: config.expiresAt || null,
    stats: {
      queueDepth: Number(queueDepth || 0),
      ordersAccepted: Number(accepted || 0),
      ordersProcessed: Number(processed || 0)
    },
    scenarios: Object.values(AIOPS_SCENARIOS).map((scenario) => ({
      name: scenario.name,
      label: scenario.label,
      description: scenario.description,
      latencyMs: Number(scenario.latencyMs || 0),
      errorRate: Number(scenario.errorRate || 0),
      workerDelayMs: Number(scenario.workerDelayMs || AIOPS_DEFAULT_CONFIG.workerDelayMs),
      logAnomaly: Boolean(scenario.logAnomaly)
    }))
  };
}

app.get('/aiops/status', async () => readAiopsStatus());

app.post('/aiops/scenarios/:name', async (request, reply) => {
  const name = String(request.params.name || '').trim();
  const config = buildScenarioConfig(name);
  if (!config) {
    reply.code(404);
    return { error: 'Unknown AIOps scenario', available: Object.keys(AIOPS_SCENARIOS) };
  }

  if (name === 'normal') {
    await redis.del('aiops:config');
    await redis.set('aiops:worker_delay_ms', String(AIOPS_DEFAULT_CONFIG.workerDelayMs));
    cachedAiopsConfig = { loadedAt: 0, value: AIOPS_DEFAULT_CONFIG };
    log({ event_type: 'aiops_scenario_reset', scenario: 'normal', message: 'AIOps scenario reset to normal operations' });
    return readAiopsStatus();
  }

  await redis.set('aiops:config', JSON.stringify(config), 'EX', Number(config.ttlSeconds || 900));
  await redis.set('aiops:worker_delay_ms', String(config.workerDelayMs || AIOPS_DEFAULT_CONFIG.workerDelayMs), 'EX', Number(config.ttlSeconds || 900));
  cachedAiopsConfig = { loadedAt: 0, value: config };
  log({ event_type: 'aiops_scenario_activated', scenario: config.name, label: config.label, expires_at: config.expiresAt });
  return readAiopsStatus();
});

function renderAiopsPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FlashScale AIOps Lab</title>
  <style>
    :root {
      --bg: #07111f;
      --surface: rgba(255,255,255,0.08);
      --surface-strong: rgba(255,255,255,0.14);
      --line: rgba(255,255,255,0.16);
      --text: #f8fafc;
      --muted: #aab6c5;
      --brand: #ff5a1f;
      --ok: #36d399;
      --warn: #fbbf24;
      --bad: #fb7185;
      --blue: #60a5fa;
      --shadow: 0 24px 80px rgba(0,0,0,0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 0%, rgba(255,90,31,0.22), transparent 32rem),
        radial-gradient(circle at 90% 4%, rgba(96,165,250,0.24), transparent 32rem),
        linear-gradient(135deg, #07111f 0%, #0b1220 45%, #121826 100%);
    }
    a { color: inherit; text-decoration: none; }
    .container { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
    .nav { border-bottom: 1px solid var(--line); background: rgba(7,17,31,0.72); backdrop-filter: blur(16px); position: sticky; top: 0; z-index: 10; }
    .nav-inner { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 900; font-size: 1.25rem; letter-spacing: -0.04em; }
    .brand-mark { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: linear-gradient(135deg, var(--brand), #ffb020); box-shadow: 0 14px 34px rgba(255,90,31,0.32); }
    .nav-links { display: flex; align-items: center; gap: 18px; color: var(--muted); font-weight: 800; }
    .nav-links a:hover { color: #fff; }
    .hero { padding: 64px 0 34px; }
    .eyebrow { display: inline-flex; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; color: #ffd8c7; background: rgba(255,90,31,0.1); font-weight: 900; }
    h1 { margin: 22px 0 16px; font-size: clamp(2.4rem, 6vw, 5.3rem); line-height: 0.95; max-width: 900px; letter-spacing: -0.07em; }
    .hero p { max-width: 770px; color: var(--muted); font-size: 1.14rem; line-height: 1.75; }
    .status-panel { margin: 26px 0 0; padding: 20px; border: 1px solid var(--line); border-radius: 26px; background: var(--surface); box-shadow: var(--shadow); display: grid; grid-template-columns: 1.4fr repeat(4, 1fr); gap: 14px; align-items: stretch; }
    .status-card { padding: 18px; border-radius: 20px; background: rgba(255,255,255,0.08); border: 1px solid var(--line); }
    .status-card strong { display: block; font-size: 1.7rem; letter-spacing: -0.04em; }
    .status-card span { color: var(--muted); font-weight: 700; font-size: 0.88rem; }
    .mode strong { color: #fff; }
    .mode .pill { display: inline-flex; margin-top: 10px; padding: 7px 10px; border-radius: 999px; background: rgba(54,211,153,0.15); color: #a7f3d0; font-weight: 900; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; padding: 34px 0 42px; }
    .scenario { border: 1px solid var(--line); border-radius: 24px; background: var(--surface); padding: 20px; box-shadow: 0 18px 50px rgba(0,0,0,0.18); }
    .scenario h3 { margin: 0 0 8px; letter-spacing: -0.03em; font-size: 1.35rem; }
    .scenario p { color: var(--muted); line-height: 1.65; min-height: 78px; }
    .scenario ul { padding-left: 18px; color: #cbd5e1; line-height: 1.7; }
    .scenario button, .reset, .refresh { width: 100%; border: 0; border-radius: 16px; padding: 13px 16px; font-weight: 900; cursor: pointer; background: #fff; color: #0b1220; }
    .scenario button:hover, .reset:hover, .refresh:hover { transform: translateY(-1px); }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
    .reset, .refresh { width: auto; background: var(--brand); color: #fff; }
    .refresh { background: var(--surface-strong); color: #fff; border: 1px solid var(--line); }
    .lesson { margin: 0 0 60px; border: 1px solid var(--line); border-radius: 28px; background: rgba(255,255,255,0.06); padding: 24px; }
    .lesson h2 { margin: 0 0 10px; letter-spacing: -0.04em; }
    .timeline { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-top: 18px; }
    .step { padding: 16px; border-radius: 18px; background: rgba(255,255,255,0.08); border: 1px solid var(--line); color: #dbeafe; font-weight: 800; }
    .toast { position: fixed; right: 18px; bottom: 18px; transform: translateY(120px); opacity: 0; transition: 0.25s ease; background: #0f172a; border: 1px solid var(--line); color: white; padding: 14px 16px; border-radius: 16px; box-shadow: var(--shadow); }
    .toast.show { transform: translateY(0); opacity: 1; }
    code { color: #fed7aa; }
    @media (max-width: 900px) { .status-panel, .grid, .timeline { grid-template-columns: 1fr; } .nav-inner { flex-direction: column; padding: 14px 0; align-items: flex-start; } }
  </style>
</head>
<body>
  <header class="nav"><div class="container nav-inner"><a class="brand" href="/"><span class="brand-mark">AI</span><span>FlashScale AIOps Lab</span></a><nav class="nav-links"><a href="/">Store</a><a href="/products">/products</a><a href="/stats">Stats</a></nav></div></header>
  <main class="container">
    <section class="hero">
      <span class="eyebrow">🤖 AIOps Classroom Mode</span>
      <h1>Make incidents visible, explainable, and recoverable.</h1>
      <p>Use controlled scenarios to teach anomaly detection, alert correlation, log investigation, queue backlogs, and remediation decisions with CloudWatch.</p>
      <div class="actions"><button class="reset" data-scenario="normal">Reset to normal</button><button class="refresh" id="refresh">Refresh status</button></div>
      <div class="status-panel">
        <div class="status-card mode"><span>Current mode</span><strong id="modeLabel">Loading...</strong><small id="modeDescription"></small><div class="pill" id="modePill">Checking</div></div>
        <div class="status-card"><span>API latency injection</span><strong id="latencyMs">0 ms</strong></div>
        <div class="status-card"><span>Error rate injection</span><strong id="errorRate">0%</strong></div>
        <div class="status-card"><span>Worker delay</span><strong id="workerDelay">25 ms</strong></div>
        <div class="status-card"><span>Queue depth</span><strong id="queueDepth">0</strong></div>
      </div>
    </section>
    <section class="grid" id="scenarioGrid"></section>
    <section class="lesson">
      <h2>How to teach this lab</h2>
      <p>Start normal traffic, activate one incident, watch CloudWatch metrics change, check logs, discuss likely root cause, then reset and scale the right component.</p>
      <div class="timeline"><div class="step">1. Baseline</div><div class="step">2. Inject scenario</div><div class="step">3. Watch anomaly</div><div class="step">4. Investigate logs</div><div class="step">5. Remediate</div></div>
    </section>
  </main>
  <div class="toast" id="toast">Ready</div>
  <script>
    const scenarioGrid = document.getElementById('scenarioGrid');
    const toast = document.getElementById('toast');
    const scenarioDetails = {
      normal: ['No artificial incident', 'Use for baseline comparison', 'Healthy mode'],
      latency: ['p95 latency rises', 'CPU may remain normal', 'Great for anomaly detection'],
      'error-spike': ['5xx errors appear', 'SNS/alarms can fire', 'Check API logs'],
      'worker-bottleneck': ['Queue depth rises', 'API can still accept orders', 'Scale workers'],
      'queue-backlog': ['Accepted > processed', 'Business workflow slows', 'Correlate queue + worker logs'],
      'log-anomaly': ['Unusual log pattern', 'Use Logs Insights', 'Good for incident notes']
    };
    function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(window.__t); window.__t = setTimeout(() => toast.classList.remove('show'), 2400); }
    async function activateScenario(name) {
      const res = await fetch('/aiops/scenarios/' + encodeURIComponent(name), { method: 'POST' });
      if (!res.ok) throw new Error('Scenario failed');
      const data = await res.json();
      render(data); showToast('Activated: ' + data.label);
    }
    function render(data) {
      document.getElementById('modeLabel').textContent = data.label;
      document.getElementById('modeDescription').textContent = data.description || '';
      document.getElementById('modePill').textContent = data.enabled ? 'Incident active' : 'Baseline';
      document.getElementById('latencyMs').textContent = data.latencyMs + ' ms';
      document.getElementById('errorRate').textContent = Math.round(data.errorRate * 100) + '%';
      document.getElementById('workerDelay').textContent = data.workerDelayMs + ' ms';
      document.getElementById('queueDepth').textContent = data.stats.queueDepth;
      scenarioGrid.innerHTML = data.scenarios.filter(s => s.name !== 'normal').map((scenario) => {
        const bullets = (scenarioDetails[scenario.name] || []).map(item => '<li>' + item + '</li>').join('');
        return '<article class="scenario"><h3>' + scenario.label + '</h3><p>' + scenario.description + '</p><ul>' + bullets + '</ul><button data-scenario="' + scenario.name + '">Activate scenario</button></article>';
      }).join('');
      document.querySelectorAll('[data-scenario]').forEach(button => button.onclick = () => activateScenario(button.dataset.scenario).catch(e => showToast(e.message)));
    }
    async function refresh() { const res = await fetch('/aiops/status'); render(await res.json()); }
    document.getElementById('refresh').onclick = refresh;
    refresh(); setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

app.get('/aiops', async (request, reply) => {
  reply.type('text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  return renderAiopsPage();
});

function renderHomePage() {
  const categoryDetails = {
    cloud: {
      label: 'Cloud Infrastructure',
      description: 'Compute, networking, and platform essentials for resilient cloud systems.',
      icon: '☁️'
    },
    devops: {
      label: 'DevOps Automation',
      description: 'CI/CD, containers, release engineering, and delivery acceleration tools.',
      icon: '⚙️'
    },
    observability: {
      label: 'Observability',
      description: 'Monitoring, logging, metrics, and tracing products for production visibility.',
      icon: '📈'
    },
    security: {
      label: 'Security',
      description: 'Practical security products for cloud workloads, teams, and pipelines.',
      icon: '🛡️'
    }
  };

  const categories = [...new Set(products.map((product) => product.category))];
  const categoryCards = categories.map((category) => {
    const details = categoryDetails[category] || { label: titleCase(category), description: 'Production-ready learning product.', icon: '✨' };
    const count = products.filter((product) => product.category === category).length;
    return `
      <button class="category-card" type="button" data-filter="${escapeHtml(category)}">
        <span class="category-icon">${details.icon}</span>
        <span class="category-info">
          <strong>${escapeHtml(details.label)}</strong>
          <small>${escapeHtml(details.description)}</small>
        </span>
        <span class="category-count">${count} items</span>
      </button>`;
  }).join('');

  const productCards = products.map((product) => {
    const details = categoryDetails[product.category] || { label: titleCase(product.category), icon: '✨' };
    const rating = (4.6 + (Number(product.id.replace('product-', '')) % 4) / 10).toFixed(1);
    return `
      <article class="product-card" data-category="${escapeHtml(product.category)}">
        <div class="product-art ${escapeHtml(product.category)}">
          <span>${details.icon}</span>
        </div>
        <div class="product-body">
          <div class="product-meta">
            <span class="pill">${escapeHtml(details.label)}</span>
            <span class="rating">★ ${rating}</span>
          </div>
          <h3>${escapeHtml(product.name)}</h3>
          <p>Production-inspired product for cloud engineering demos, autoscaling lessons, and traffic testing labs.</p>
          <div class="product-bottom">
            <div>
              <strong>$${Number(product.price).toFixed(2)}</strong>
              <small>${Number(product.stock).toLocaleString()} in stock</small>
            </div>
            <button class="order-btn" type="button" data-product-id="${escapeHtml(product.id)}">Add to order</button>
          </div>
        </div>
      </article>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FlashScale Store</title>
  <style>
    :root {
      --bg: #f6f8fc;
      --surface: #ffffff;
      --ink: #102033;
      --muted: #667085;
      --brand: #ff5a1f;
      --brand-dark: #d83b00;
      --line: #e6eaf2;
      --soft: #fff2ec;
      --shadow: 0 24px 70px rgba(16, 32, 51, 0.12);
      --radius: 24px;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(255, 90, 31, 0.14), transparent 34rem),
        radial-gradient(circle at 85% 8%, rgba(30, 64, 175, 0.12), transparent 26rem),
        var(--bg);
    }

    a { color: inherit; text-decoration: none; }
    .container { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }

    .nav {
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(16px);
      background: rgba(246, 248, 252, 0.82);
      border-bottom: 1px solid rgba(230, 234, 242, 0.8);
    }

    .nav-inner {
      min-height: 76px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 900;
      letter-spacing: -0.04em;
      font-size: 1.35rem;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: white;
      background: linear-gradient(135deg, var(--brand), #ff9f1c);
      box-shadow: 0 12px 26px rgba(255, 90, 31, 0.32);
    }

    .nav-links { display: flex; align-items: center; gap: 18px; color: var(--muted); font-weight: 700; }
    .nav-links a:hover { color: var(--brand-dark); }
    .nav-cta {
      padding: 12px 18px;
      border-radius: 999px;
      color: #fff;
      background: var(--ink);
    }

    .hero {
      padding: 72px 0 48px;
    }

    .hero-grid {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 38px;
      align-items: center;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border: 1px solid #ffd1c0;
      border-radius: 999px;
      background: var(--soft);
      color: var(--brand-dark);
      font-weight: 800;
      font-size: 0.86rem;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0;
      font-size: clamp(2.7rem, 7vw, 5.7rem);
      line-height: 0.95;
      letter-spacing: -0.08em;
    }

    .hero-copy {
      margin: 22px 0 0;
      max-width: 680px;
      color: var(--muted);
      font-size: 1.15rem;
      line-height: 1.75;
    }

    .hero-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 30px; }
    .button {
      border: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 20px;
      border-radius: 999px;
      font-weight: 900;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .button:hover { transform: translateY(-2px); }
    .primary { color: white; background: linear-gradient(135deg, var(--brand), #ff8a3d); box-shadow: 0 16px 34px rgba(255, 90, 31, 0.28); }
    .secondary { background: white; border: 1px solid var(--line); color: var(--ink); }

    .hero-panel {
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.9);
      border-radius: 34px;
      padding: 24px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .hero-product {
      min-height: 420px;
      border-radius: 28px;
      padding: 26px;
      background:
        linear-gradient(150deg, rgba(16, 32, 51, 0.98), rgba(28, 45, 72, 0.95)),
        radial-gradient(circle at top right, rgba(255, 90, 31, 0.8), transparent 18rem);
      color: white;
      position: relative;
    }

    .hero-product::after {
      content: "";
      position: absolute;
      inset: auto -70px -90px auto;
      width: 260px;
      height: 260px;
      border-radius: 50%;
      background: rgba(255, 90, 31, 0.38);
      filter: blur(2px);
    }

    .floating-card {
      position: relative;
      z-index: 1;
      margin-top: 22px;
      padding: 18px;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.18);
    }
    .hero-product h2 { margin: 0 0 8px; font-size: 2rem; letter-spacing: -0.04em; }
    .hero-product p { color: rgba(255,255,255,0.72); line-height: 1.65; }
    .live-badge { display: inline-flex; align-items: center; gap: 8px; font-weight: 900; color: #bbf7d0; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 8px rgba(34,197,94,0.14); }

    .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 22px; }
    .stat {
      padding: 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.16);
    }
    .stat strong { display: block; font-size: 1.45rem; }
    .stat span { color: rgba(255,255,255,0.68); font-size: 0.85rem; }

    .section { padding: 42px 0; }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
    .section h2 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -0.06em; }
    .section p.lead { margin: 10px 0 0; color: var(--muted); line-height: 1.7; max-width: 720px; }

    .category-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
    }

    .category-card {
      text-align: left;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.86);
      border-radius: var(--radius);
      padding: 20px;
      cursor: pointer;
      min-height: 168px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 10px 30px rgba(16, 32, 51, 0.06);
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .category-card:hover, .category-card.active {
      transform: translateY(-4px);
      border-color: #ffba9e;
      box-shadow: 0 20px 44px rgba(255, 90, 31, 0.12);
    }
    .category-icon { font-size: 2rem; }
    .category-info strong { display: block; font-size: 1.05rem; letter-spacing: -0.02em; }
    .category-info small { display: block; margin-top: 7px; color: var(--muted); line-height: 1.45; }
    .category-count { margin-top: auto; color: var(--brand-dark); font-weight: 900; font-size: 0.88rem; }

    .shop-toolbar {
      margin: 26px 0;
      display: flex;
      gap: 14px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      padding: 14px;
      background: rgba(255,255,255,0.78);
      border: 1px solid var(--line);
      border-radius: 22px;
    }
    .filter-chips { display: flex; gap: 10px; flex-wrap: wrap; }
    .chip {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 900;
      color: var(--muted);
    }
    .chip.active { color: white; background: var(--ink); border-color: var(--ink); }
    .search {
      min-width: min(330px, 100%);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 12px 16px;
      outline: none;
      font-weight: 700;
    }
    .search:focus { border-color: #ffad8c; box-shadow: 0 0 0 4px rgba(255,90,31,0.1); }

    .product-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 18px;
    }

    .product-card {
      border-radius: var(--radius);
      background: #fff;
      border: 1px solid var(--line);
      overflow: hidden;
      box-shadow: 0 12px 34px rgba(16, 32, 51, 0.07);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .product-card:hover { transform: translateY(-5px); box-shadow: 0 22px 44px rgba(16, 32, 51, 0.12); }
    .product-card.hidden { display: none; }
    .product-art {
      height: 150px;
      display: grid;
      place-items: center;
      font-size: 3.6rem;
      background: linear-gradient(135deg, #f8fafc, #eef2ff);
    }
    .product-art.cloud { background: linear-gradient(135deg, #e0f2fe, #eff6ff); }
    .product-art.devops { background: linear-gradient(135deg, #fff7ed, #ffedd5); }
    .product-art.observability { background: linear-gradient(135deg, #ecfdf5, #d1fae5); }
    .product-art.security { background: linear-gradient(135deg, #f5f3ff, #ede9fe); }
    .product-body { padding: 18px; }
    .product-meta { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .pill { font-size: 0.75rem; color: var(--brand-dark); background: var(--soft); border-radius: 999px; padding: 7px 10px; font-weight: 900; }
    .rating { color: #f59e0b; font-weight: 900; font-size: 0.85rem; }
    .product-body h3 { margin: 14px 0 8px; font-size: 1.08rem; letter-spacing: -0.03em; }
    .product-body p { margin: 0; color: var(--muted); line-height: 1.55; font-size: 0.92rem; }
    .product-bottom { margin-top: 18px; display: flex; justify-content: space-between; gap: 12px; align-items: end; }
    .product-bottom strong { display: block; font-size: 1.2rem; }
    .product-bottom small { color: var(--muted); }
    .order-btn {
      border: 0;
      border-radius: 999px;
      background: var(--ink);
      color: white;
      padding: 10px 13px;
      cursor: pointer;
      font-weight: 900;
      white-space: nowrap;
    }
    .order-btn:hover { background: var(--brand-dark); }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 26px;
      transform: translateX(-50%) translateY(120px);
      opacity: 0;
      background: var(--ink);
      color: white;
      padding: 14px 18px;
      border-radius: 999px;
      box-shadow: var(--shadow);
      transition: all 0.24s ease;
      z-index: 50;
      font-weight: 900;
    }
    .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }

    .footer { padding: 46px 0 60px; color: var(--muted); text-align: center; }

    @media (max-width: 980px) {
      .hero-grid { grid-template-columns: 1fr; }
      .category-grid, .product-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 640px) {
      .container { width: min(100% - 28px, 1180px); }
      .nav-inner { align-items: flex-start; flex-direction: column; padding: 16px 0; }
      .nav-links { width: 100%; justify-content: space-between; font-size: 0.92rem; }
      .hero { padding-top: 44px; }
      .hero-panel { padding: 14px; }
      .hero-product { min-height: 360px; }
      .stat-row, .category-grid, .product-grid { grid-template-columns: 1fr; }
      .section-head { display: block; }
      .shop-toolbar { align-items: stretch; }
      .search { width: 100%; }
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="container nav-inner">
      <a class="brand" href="/" aria-label="FlashScale Store home">
        <span class="brand-mark">FS</span>
        <span>FlashScale Store</span>
      </a>
      <nav class="nav-links" aria-label="Main navigation">
        <a href="#categories">Categories</a>
        <a href="#shop">Shop</a>
        <a href="/products">/products API</a>
        <a href="/aiops">AIOps Lab</a>
        <a class="nav-cta" href="/stats">Live stats</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <span class="eyebrow">⚡ Cloud Engineering Demo Store</span>
          <h1>Shop the stack that survives traffic spikes.</h1>
          <p class="hero-copy">A polished product storefront powered by the same <strong>/products</strong> catalog used for your load-testing demo. Students can browse categories, place sample orders, and watch traffic appear in CloudWatch.</p>
          <div class="hero-actions">
            <a class="button primary" href="#shop">Browse products</a>
            <a class="button secondary" href="/products">View JSON API</a>
            <a class="button secondary" href="/aiops">Open AIOps Lab</a>
          </div>
        </div>
        <aside class="hero-panel" aria-label="Store status">
          <div class="hero-product">
            <span class="live-badge"><span class="dot"></span>Live EC2 target app</span>
            <div class="floating-card">
              <h2>Realistic shopping traffic for DevOps labs</h2>
              <p>Use this home page for human-friendly demos and keep <strong>/products</strong> unchanged for k6, DLT, and backend testing.</p>
              <div class="stat-row">
                <div class="stat"><strong>${products.length}</strong><span>Products</span></div>
                <div class="stat"><strong>${categories.length}</strong><span>Categories</span></div>
                <div class="stat"><strong>CloudWatch</strong><span>Monitoring</span></div>
                <div class="stat"><strong>AIOps</strong><span>Lab mode</span></div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <section id="categories" class="section">
      <div class="container">
        <div class="section-head">
          <div>
            <h2>Shop by category</h2>
            <p class="lead">Products are grouped the way a real customer-facing catalog would be organized, while still using your existing backend product data.</p>
          </div>
        </div>
        <div class="category-grid">
          ${categoryCards}
        </div>
      </div>
    </section>

    <section id="shop" class="section">
      <div class="container">
        <div class="section-head">
          <div>
            <h2>Featured products</h2>
            <p class="lead">Filter products, search the catalog, and create sample orders using the existing <strong>POST /orders</strong> endpoint.</p>
          </div>
        </div>
        <div class="shop-toolbar">
          <div class="filter-chips">
            <button class="chip active" type="button" data-filter="all">All</button>
            ${categories.map((category) => `<button class="chip" type="button" data-filter="${escapeHtml(category)}">${escapeHtml(titleCase(category))}</button>`).join('')}
          </div>
          <input class="search" id="search" type="search" placeholder="Search products..." autocomplete="off" />
        </div>
        <div class="product-grid" id="productGrid">
          ${productCards}
        </div>
      </div>
    </section>
  </main>

  <div class="toast" id="toast" role="status" aria-live="polite">Order accepted</div>

  <footer class="footer">
    <div class="container">FlashScale Store · EC2 Docker target app · CloudWatch + DLT classroom demo</div>
  </footer>

  <script>
    const chips = Array.from(document.querySelectorAll('[data-filter]'));
    const productCards = Array.from(document.querySelectorAll('.product-card'));
    const search = document.getElementById('search');
    const toast = document.getElementById('toast');
    let activeFilter = 'all';

    function normalize(value) {
      return String(value || '').toLowerCase().trim();
    }

    function applyFilters(filter) {
      if (filter) activeFilter = filter;
      const query = normalize(search.value);
      productCards.forEach((card) => {
        const matchesCategory = activeFilter === 'all' || card.dataset.category === activeFilter;
        const matchesSearch = !query || normalize(card.innerText).includes(query);
        card.classList.toggle('hidden', !(matchesCategory && matchesSearch));
      });
      chips.forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === activeFilter));
    }

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        applyFilters(chip.dataset.filter);
        document.getElementById('shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    search.addEventListener('input', () => applyFilters());

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(window.__flashScaleToastTimer);
      window.__flashScaleToastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
    }

    document.querySelectorAll('.order-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const productId = button.dataset.productId;
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = 'Adding...';
        try {
          const response = await fetch('/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, quantity: 1 })
          });
          if (!response.ok) throw new Error('Order failed');
          showToast('Order accepted for ' + productId);
        } catch (error) {
          showToast('Order failed. Check logs.');
        } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      });
    });
  </script>
</body>
</html>`;
}

app.get('/', async (request, reply) => {
  reply.type('text/html; charset=utf-8');
  reply.header('Cache-Control', 'public, max-age=10');
  return renderHomePage();
});

process.on('SIGTERM', async () => {
  log({ event_type: 'shutdown', message: 'SIGTERM received' });
  await app.close();
  redis.disconnect();
  process.exit(0);
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  log({ event_type: 'startup', message: `API listening on ${PORT}` });
});
