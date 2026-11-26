'use strict';

const { monitorEventLoopDelay } = require('perf_hooks');

const THRESHOLD_MS = Number(process.env.EVENT_LOOP_LAG_THRESHOLD_MS || 100);
const SAMPLE_INTERVAL_MS = Number(process.env.EVENT_LOOP_LAG_INTERVAL_MS || 5000);
const HEAP_WARN_MB = Number(process.env.HEAP_WARN_MB || 256);

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

    // Heap-usage monitor for real leaks. Comparing used/heapTotal is
    // meaningless on a young process: V8 grows heapTotal lazily, so a healthy
    // 20 MB heap routinely sits above 90% and logged a warning every sample.
    // Only report once absolute usage is large enough to matter.
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / (1024 * 1024);
    if (heapUsedMB >= HEAP_WARN_MB) {
      console.warn(
        `[memory] heap ${heapUsedMB.toFixed(1)}MB / ${(mem.heapTotal / (1024 * 1024)).toFixed(1)}MB, rss ${(mem.rss / (1024 * 1024)).toFixed(1)}MB`
      );
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
