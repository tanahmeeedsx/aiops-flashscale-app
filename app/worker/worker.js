import Redis from 'ioredis';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const ORDER_PROCESSING_MS = Number(process.env.ORDER_PROCESSING_MS || 25);
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

function log(obj) {
  process.stdout.write(JSON.stringify({ source: 'worker', timestamp: new Date().toISOString(), ...obj }) + '\n');
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function getProcessingDelay() {
  try {
    const dynamicDelay = await redis.get('aiops:worker_delay_ms');
    const parsed = Number(dynamicDelay || ORDER_PROCESSING_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : ORDER_PROCESSING_MS;
  } catch (err) {
    log({ event_type: 'worker_error', message: 'Could not read AIOps worker delay: ' + err.message });
    return ORDER_PROCESSING_MS;
  }
}

async function emitStats() {
  try {
    const [queueDepth, accepted, processed] = await Promise.all([
      redis.llen('orders:queue'), redis.get('orders:accepted'), redis.get('orders:processed')
    ]);
    log({ event_type: 'worker_stats', queue_depth: Number(queueDepth || 0), orders_accepted_total: Number(accepted || 0), orders_processed_total: Number(processed || 0) });
  } catch (err) {
    log({ event_type: 'worker_error', message: err.message });
  }
}

async function main() {
  log({ event_type: 'startup', message: 'Worker started' });
  setInterval(emitStats, 10000).unref();
  while (true) {
    try {
      const result = await redis.brpop('orders:queue', 5);
      if (!result) { await emitStats(); continue; }
      const order = JSON.parse(result[1]);
      const processingDelay = await getProcessingDelay();
      await sleep(processingDelay);
      await redis.incr('orders:processed');
      if (processingDelay >= 300) {
        log({ event_type: 'aiops_worker_bottleneck', delay_ms: processingDelay, message: 'Controlled AIOps lab worker delay is active' });
      }
      log({ event_type: 'order_processed', order_id: order.id, product_id: order.productId, processing_ms: processingDelay });
    } catch (err) {
      log({ event_type: 'worker_error', message: err.message });
      await sleep(1000);
    }
  }
}

process.on('SIGTERM', () => {
  log({ event_type: 'shutdown', message: 'SIGTERM received' });
  redis.disconnect();
  process.exit(0);
});
main().catch((err) => { log({ event_type: 'fatal', message: err.message }); process.exit(1); });
