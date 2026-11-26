'use strict';

/**
 * Player-submitted community reports.
 * Reports land in the moderation queue the admin console reads. Duplicate
 * open reports for the same target by the same reporter are collapsed.
 */

const { admin, one } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');

const TARGETS = new Set(['user', 'chat_message', 'world_message', 'match']);

async function create(reporter, input = {}) {
  const targetType = TARGETS.has(input.targetType) ? input.targetType : null;
  const targetId = String(input.targetId ?? '').trim().slice(0, 80);
  const reason = cleanText(input.reason, 160);
  if (!targetType) throw ApiError.badRequest('INVALID_TARGET', 'Choose what you are reporting');
  if (!targetId) throw ApiError.badRequest('TARGET_REQUIRED', 'The reported item is missing');
  if (reason.length < 3) throw ApiError.badRequest('REASON_REQUIRED', 'Tell us what happened');
  if (targetType === 'user' && String(targetId) === String(reporter.id)) {
    throw ApiError.badRequest('CANNOT_REPORT_SELF', 'You cannot report yourself');
  }

  const existing = await one(
    admin
      .from('content_reports')
      .select('id')
      .eq('reporter_id', reporter.id)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .in('status', ['open', 'reviewing'])
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .maybeSingle(),
    'Could not check your report'
  ).catch(() => null);
  if (existing) {
    return { message: 'Our moderators are already reviewing this report', reportId: existing.id };
  }

  const row = await one(
    admin
      .from('content_reports')
      .insert({
        reporter_id: reporter.id,
        target_type: targetType,
        target_id: targetId,
        reason,
        details: cleanMultiline(input.details, 2000)
      })
      .select('id, status, created_at')
      .single(),
    'Could not submit your report'
  );
  return { message: 'Report submitted for moderator review', report: row };
}

module.exports = { create };
