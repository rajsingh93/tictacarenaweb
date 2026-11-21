'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

const THRESHOLD_MS = Number(process.env.EVENT_LOOP_LAG_THRESHOLD_MS || 100);
const SAMPLE_INTERVAL_MS = Number(process.env.EVENT_LOOP_LAG_INTERVAL_MS || 5000);

let histogram = null;
let timer = null;

function start() {
  if (timer) return;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch (_) {
    histogram = null;
    return;
  }

  timer = setInterval(() => {
    if (!histogram) return;
    const p99 = (histogram.percentile(99) || 0) / 1e6; // ns -> ms
    if (p99 >= THRESHOLD_MS) {
      console.warn(`[event-loop] p99 lag ${p99.toFixed(1)}ms (threshold ${THRESHOLD_MS}ms)`);
    }
    histogram.reset();

    // Lightweight heap-usage monitor to surface leaks early.
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / (1024 * 1024);
    const heapTotalMB = mem.heapTotal / (1024 * 1024);
    if (heapTotalMB > 0 && heapUsedMB / heapTotalMB >= 0.9) {
      console.warn(`[memory] heap ${heapUsedMB.toFixed(1)}MB / ${heapTotalMB.toFixed(1)}MB (${((heapUsedMB / heapTotalMB) * 100).toFixed(0)}%)`);
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (histogram) {
    try { histogram.disable(); } catch (_) {}
    histogram = null;
  }
}

module.exports = { start, stop };
