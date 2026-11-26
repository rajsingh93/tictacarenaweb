'use strict';

/**
 * Central retention runner.
 *
 * One code path serves the scheduled job and the administrator's manual run,
 * so both produce the same counts, the same audit entry and the same ledger
 * row. Concurrency is prevented twice: the database function takes an
 * advisory transaction lock, and this service refuses to start while a recent
 * run is still marked running.
 */

const { admin, one, many, rpc } = require('../utils/db');
const settingsService = require('./settings.service');
const audit = require('./audit.service');

const OVERLAP_WINDOW_MS = 15 * 60 * 1000;
const HISTORY_LIMIT = 10;

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function activeRun() {
  return one(
    admin
      .from('cleanup_runs')
      .select('id, trigger_source, started_at')
      .eq('status', 'running')
      .gte('started_at', new Date(Date.now() - OVERLAP_WINDOW_MS).toISOString())
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'Could not check for a running cleanup'
  ).catch(() => null);
}

async function history(limit = HISTORY_LIMIT) {
  const size = Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), 25);
  return many(
    admin
      .from('cleanup_runs')
      .select('id, trigger_source, status, actor_id, counts, error, started_at, finished_at, duration_ms')
      .order('started_at', { ascending: false })
      .limit(size),
    'Could not load cleanup history'
  ).catch(() => []);
}

async function run({ actor = null, req = null, triggerSource = 'manual' } = {}) {
  const source = ['scheduled', 'manual', 'startup'].includes(triggerSource) ? triggerSource : 'manual';
  const inFlight = await activeRun();
  if (inFlight) {
    return {
      skipped: true,
      reason: 'ALREADY_RUNNING',
      runId: inFlight.id,
      startedAt: inFlight.started_at
    };
  }

  const policy = await settingsService.retention();
  const startedAt = new Date();
  const started = Date.now();
  const runRow = await one(
    admin
      .from('cleanup_runs')
      .insert({
        trigger_source: source,
        status: 'running',
        actor_id: actor?.id || null,
        started_at: startedAt.toISOString()
      })
      .select('id, started_at')
      .single(),
    'Could not start the cleanup ledger'
  );

  try {
    const result = await rpc(
      'run_retention_cleanup',
      {
        p_admin_login_days: policy.adminLoginDays,
        p_error_days: policy.errorDays,
        p_notification_days: policy.notificationDays,
        p_batch: 1000
      },
      'Could not run the retention cleanup'
    );

    const skipped = Boolean(result?.skipped);
    const counts = result?.deleted || {};
    const duration = Date.now() - started;
    await admin
      .from('cleanup_runs')
      .update({
        status: skipped ? 'skipped' : 'succeeded',
        counts,
        error: skipped ? String(result?.reason || 'ALREADY_RUNNING').slice(0, 300) : null,
        finished_at: new Date().toISOString(),
        duration_ms: duration
      })
      .eq('id', runRow.id);

    if (actor && !skipped) {
      await audit
        .record(actor, 'system.retention.manual_cleanup', {
          targetType: 'retention',
          targetId: 'manual',
          details: { counts, durationMs: duration },
          req
        })
        .catch(() => null);
    }

    return {
      skipped,
      reason: skipped ? result?.reason || 'ALREADY_RUNNING' : null,
      runId: runRow.id,
      counts,
      deletedTotal: Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0),
      durationMs: duration,
      finishedAt: iso(result?.finishedAt) || new Date().toISOString()
    };
  } catch (error) {
    try {
      await admin
        .from('cleanup_runs')
        .update({
          status: 'failed',
          error: String(error.message || 'Cleanup failed').slice(0, 500),
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - started
        })
        .eq('id', runRow.id);
    } catch (_) {
      /* the original failure is more useful than a ledger write error */
    }
    throw error;
  }
}

module.exports = { run, history, activeRun, HISTORY_LIMIT };
