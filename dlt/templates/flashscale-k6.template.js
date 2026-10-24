import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = '__BASE_URL__';
const PEAK_VUS = __PEAK_VUS__;
const ORDER_RATIO = Number('__ORDER_RATIO__');
const FORCE_DURATION = null;

function stagesForPeak(peak) {
  if (FORCE_DURATION) return [{ duration: '30s', target: peak }, { duration: FORCE_DURATION, target: peak }, { duration: '30s', target: 0 }];
  if (peak <= 1000) return [{ duration: '2m', target: Math.ceil(peak * 0.25) }, { duration: '2m', target: Math.ceil(peak * 0.50) }, { duration: '2m', target: peak }, { duration: '5m', target: peak }, { duration: '2m', target: 0 }];
  if (peak <= 10000) return [{ duration: '5m', target: Math.ceil(peak * 0.10) }, { duration: '5m', target: Math.ceil(peak * 0.25) }, { duration: '5m', target: Math.ceil(peak * 0.50) }, { duration: '10m', target: peak }, { duration: '10m', target: peak }, { duration: '5m', target: 0 }];
  return [{ duration: '10m', target: Math.ceil(peak * 0.10) }, { duration: '10m', target: Math.ceil(peak * 0.25) }, { duration: '10m', target: Math.ceil(peak * 0.50) }, { duration: '15m', target: peak }, { duration: '10m', target: peak }, { duration: '10m', target: 0 }];
}

export const options = {
  scenarios: { flashscale_mixed_traffic: { executor: 'ramping-vus', startVUs: 0, stages: stagesForPeak(PEAK_VUS), gracefulRampDown: '30s' } },
  thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<1500'] },
  userAgent: `FlashScale-DLT-k6/${PEAK_VUS}vus`
};

function randomProductId() { return `product-${Math.floor(Math.random() * 100) + 1}`; }

export default function () {
  const dice = Math.random();
  if (dice < 0.05) {
    const res = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'health' } });
    check(res, { 'health 200': (r) => r.status === 200 });
  } else if (dice < 0.95) {
    const res = http.get(`${BASE_URL}/products`, { tags: { endpoint: 'products' } });
    check(res, { 'products 200': (r) => r.status === 200 });
  } else {
    const res = http.get(`${BASE_URL}/products/${randomProductId()}`, { tags: { endpoint: 'product_detail' } });
    check(res, { 'product detail ok': (r) => r.status === 200 || r.status === 404 });
  }
  if (Math.random() < ORDER_RATIO) {
    const payload = JSON.stringify({ productId: randomProductId(), quantity: 1 });
    const res = http.post(`${BASE_URL}/orders`, payload, { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'orders' } });
    check(res, { 'order accepted': (r) => r.status === 202 || r.status === 200 });
  }
  sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
  return { stdout: JSON.stringify({ peak_vus: PEAK_VUS, base_url: BASE_URL, order_ratio: ORDER_RATIO, http_req_failed_rate: data.metrics.http_req_failed?.rate, iterations: data.metrics.iterations?.count }, null, 2) + '\n' };
}
