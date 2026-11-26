'use strict';

/**
 * TicTacArena — Admin Control Center: notifications, CMS and support.
 *
 * CMS content is served to the public site from the same database rows the
 * console edits, so a published change is visible without a redeploy.
 * Notification delivery is the real in-app feed; FCM is reported as
 * unavailable unless the deployment actually configures it.
 */

const { admin, one, many, count } = require('../utils/db');
const { ApiError } = require('../utils/ApiError');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const audit = require('./audit.service');
const notificationService = require('./notification.service');
const settingsService = require('./settings.service');
const env = require('../config/env');

const MAX_PAGE = 100;
const AUDIENCE_KINDS = new Set(['all', 'active_7d', 'active_30d', 'new_30d', 'inactive_30d', 'top_players', 'custom']);
const CAMPAIGN_STATUSES = new Set(['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled']);
const NOTIFICATION_TYPES = new Set(['system', 'reward', 'match', 'friend']);
const TICKET_STATUSES = new Set(['open', 'in_progress', 'closed']);
const TICKET_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'list', 'quote', 'cta', 'image']);
const PAGE_STATUSES = new Set(['draft', 'published', 'archived']);
// Public indexable pages
const STATIC_PAGES = [
  ['home', '/'],
  ['about', '/about'],
  ['leaderboard', '/leaderboard'],
  ['faq', '/faq'],
  ['terms', '/terms'],
  ['privacy', '/privacy'],
  ['contact', '/contact']
];

const STATIC_PAGE_DEFAULTS = {
  home: {
    title: 'TicTacArena — Competitive Online Multiplayer Tic-Tac-Toe',
    description: 'Play fast, competitive multiplayer Tic-Tac-Toe online. Climb ranked ladders, compete in real-time matches, challenge friends, and earn rewards on TicTacArena.'
  },
  leaderboard: {
    title: 'TicTacArena Leaderboard — Top Ranked Players & ELO Standings',
    description: 'Explore the official TicTacArena global leaderboard. Track top ranked Tic-Tac-Toe players, competitive ELO standings, win rates, and division tiers.'
  },
  about: {
    title: 'About TicTacArena — Online Multiplayer Strategy & Ranked Play',
    description: 'Learn about TicTacArena, the competitive multiplayer Tic-Tac-Toe platform connecting players worldwide through ranked matches, ELO ladders, and tournaments.'
  },
  faq: {
    title: 'TicTacArena FAQ — Rules, ELO Ratings, Accounts & Support',
    description: 'Find answers to common questions about TicTacArena rules, ELO rating calculations, matchmaking, account settings, friend duels, and game support.'
  },
  contact: {
    title: 'Contact TicTacArena — Support, Feedback & Player Inquiries',
    description: 'Need help with your TicTacArena account, found a bug, or have suggestions? Contact our support team for prompt assistance and player feedback.'
  },
  privacy: {
    title: 'Privacy Policy — TicTacArena',
    description: 'Read how TicTacArena collects, protects, and handles your account data and privacy in compliance with global standards.'
  },
  terms: {
    title: 'Terms of Service — TicTacArena',
    description: 'Review the terms and conditions for playing, competing in ranked matches, and participating in the TicTacArena community.'
  }
};

const PUBLIC_PAGE_SLUGS = new Set(STATIC_PAGES.map(([slug]) => slug));

const RESTRICTED_PATHS = [
  '/admin',
  '/dashboard',
  '/profile',
  '/settings',
  '/game',
  '/match',
  '/play-friends',
  '/chat',
  '/world-chat',
  '/friends',
  '/mailbox',
  '/notifications',
  '/history',
  '/vault',
  '/topup',
  '/shop',
  '/achievements',
  '/leaderboard',
  '/login',
  '/signup',
  '/forgot',
  '/reset',
  '/maintenance',
  '/offline',
  '/error'
];

function toId(value, label = 'identifier') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('INVALID_ID', `Choose a valid ${label}`);
  return id;
}

function listParams(query = {}, fallback = 25) {
  const limit = Math.min(Math.max(Number(query.limit) || fallback, 1), MAX_PAGE);
  const page = Math.min(Math.max(Number(query.page) || 1, 1), 100000);
  return { limit, page, from: (page - 1) * limit, to: page * limit - 1 };
}

function searchTerm(value, max = 80) {
  return cleanText(value, max).replace(/[(),%*]/g, '').trim();
}

function pageResult(rows, total, params) {
  return {
    rows,
    total: Number(total) || 0,
    page: params.page,
    limit: params.limit,
    pages: Math.max(1, Math.ceil((Number(total) || 0) / params.limit))
  };
}

async function notify(userId, payload) {
  try {
    await notificationService.create({ userId, ...payload });
  } catch (_) {
    /* courtesy notification */
  }
}

// 

function pushStatus() {
  const configured = Boolean(
    process.env.FCM_SERVER_KEY ||
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_PROJECT_ID
  );
  return {
    configured,
    provider: configured ? 'firebase' : 'in-app',
    label: configured ? 'Firebase Cloud Messaging' : 'In-app notification feed',
    note: configured
      ? 'Push credentials are configured on the server.'
      : 'No FCM credentials are configured. Campaigns are delivered to the in-app feed and mailbox.'
  };
}

function campaignRow(row) {
  const audience = row.audience === 'custom'
    ? `custom:${Array.isArray(row.audience_ids) ? row.audience_ids.length : 0} players`
    : row.audience;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    title: row.title,
    body: row.body,
    reward_coins: row.reward_coins,
    audience: row.audience,
    audience_label: audience,
    audience_count: Array.isArray(row.audience_ids) ? row.audience_ids.length : 0,
    status: row.status,
    scheduled_at: row.scheduled_at,
    sent_at: row.sent_at,
    recipient_count: row.recipient_count,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function notificationOverview() {
  const [drafts, scheduled, sent, failed, templates, inApp, mail] = await Promise.all([
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'draft')).catch(() => 0),
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'scheduled')).catch(() => 0),
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'sent')).catch(() => 0),
    count(admin.from('notification_campaigns').select('id', { count: 'exact', head: true }).eq('status', 'failed')).catch(() => 0),
    count(admin.from('notification_templates').select('id', { count: 'exact', head: true })).catch(() => 0),
    count(admin.from('notifications').select('id', { count: 'exact', head: true })).catch(() => 0),
    count(admin.from('notifications').select('id', { count: 'exact', head: true }).gt('reward_coins', 0)).catch(() => 0)
  ]);
  return {
    campaigns: { drafts, scheduled, sent, failed },
    templates,
    inApp,
    mail,
    push: pushStatus(),
    generatedAt: new Date().toISOString()
  };
}

async function listCampaigns(query = {}) {
  const params = listParams(query, 20);
  const status = CAMPAIGN_STATUSES.has(query.status) ? query.status : null;
  const term = searchTerm(query.q);
  let base = admin
    .from('notification_campaigns')
    .select('id, name, type, title, body, reward_coins, audience, audience_ids, status, scheduled_at, sent_at, recipient_count, error, created_at, updated_at', { count: 'exact' });
  if (status) base = base.eq('status', status);
  if (term) base = base.or(`name.ilike.%${term}%,title.ilike.%${term}%`);
  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load notification campaigns');
  return pageResult((data || []).map(campaignRow), total, params);
}

async function audienceIds(audience, ids = []) {
  if (audience === 'custom') {
    return [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 20000);
  }
  const now = Date.now();
  let query = admin.from('users').select('id').eq('is_bot', false).eq('is_banned', false);
  if (audience === 'active_7d') query = query.gte('last_seen', new Date(now - 7 * 86400000).toISOString());
  if (audience === 'active_30d') query = query.gte('last_seen', new Date(now - 30 * 86400000).toISOString());
  if (audience === 'inactive_30d') query = query.lt('last_seen', new Date(now - 30 * 86400000).toISOString());
  if (audience === 'new_30d') query = query.gte('created_at', new Date(now - 30 * 86400000).toISOString());
  if (audience === 'top_players') query = query.order('score', { ascending: false }).limit(200);

  const collected = [];
  let offset = 0;
  while (collected.length < 20000) {
    const rows = await many(query.range(offset, offset + 999), 'Could not resolve the audience');
    if (!rows.length) break;
    collected.push(...rows.map((row) => Number(row.id)).filter(Boolean));
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return [...new Set(collected)];
}

async function audienceCount(audience, ids = []) {
  if (audience === 'custom') return (Array.isArray(ids) ? ids : []).length;
  if (audience === 'all') {
    return count(admin.from('users').select('id', { count: 'exact', head: true }).eq('is_bot', false).eq('is_banned', false)).catch(() => 0);
  }
  return (await audienceIds(audience, ids)).length;
}

async function saveCampaign(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'campaign') : null;
  const name = cleanText(input.name, 100);
  const title = cleanText(input.title, 120);
  const body = cleanMultiline(input.body, 2000);
  if (name.length < 3) throw ApiError.badRequest('INVALID_NAME', 'Campaign name must be at least 3 characters');
  if (title.length < 3) throw ApiError.badRequest('INVALID_TITLE', 'Write a notification title');
  if (body.length < 5) throw ApiError.badRequest('INVALID_BODY', 'Write the notification body');
  const type = NOTIFICATION_TYPES.has(input.type) ? input.type : 'system';
  const audience = AUDIENCE_KINDS.has(input.audience) ? input.audience : 'all';
  const rewardCoins = Math.min(Math.max(Number(input.reward_coins) || 0, 0), 1000000);
  const audienceList = audience === 'custom'
    ? [...new Set((Array.isArray(input.audience_ids) ? input.audience_ids : []).map(Number).filter(Boolean))].slice(0, 20000)
    : [];
  if (audience === 'custom' && !audienceList.length) {
    throw ApiError.badRequest('AUDIENCE_REQUIRED', 'Choose at least one player for a custom audience');
  }
  const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw ApiError.badRequest('INVALID_DATE', 'Enter a valid schedule time');
  const status = scheduledAt && scheduledAt.getTime() > Date.now() ? 'scheduled' : 'draft';

  const payload = {
    name,
    type,
    title,
    body,
    reward_coins: rewardCoins,
    audience,
    audience_ids: audienceList,
    status,
    scheduled_at: scheduledAt ? scheduledAt.toISOString() : null
  };

  if (id) {
    const existing = await one(admin.from('notification_campaigns').select('id, status').eq('id', id).maybeSingle(), 'Could not load that campaign');
    if (!existing) throw ApiError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
    if (existing.status === 'sending') throw ApiError.conflict('CAMPAIGN_SENDING', 'This campaign is currently sending');
    if (existing.status === 'sent') throw ApiError.conflict('CAMPAIGN_SENT', 'A sent campaign is kept as history; create a new campaign to send it again');
    const row = await one(
      admin.from('notification_campaigns').update(payload).eq('id', id).select('*').single(),
      'Could not update the campaign'
    );
    await audit.record(actor, 'notification.campaign.update', { targetType: 'campaign', targetId: id, details: { name, audience }, req });
    return { message: 'Campaign saved', campaign: campaignRow(row) };
  }

  const row = await one(
    admin
      .from('notification_campaigns')
      .insert({ ...payload, created_by: actor.id })
      .select('*')
      .single(),
    'Could not create the campaign'
  );
  await audit.record(actor, 'notification.campaign.create', {
    targetType: 'campaign',
    targetId: row.id,
    details: { name, audience, scheduled: Boolean(payload.scheduled_at) },
    req
  });
  return { message: 'Campaign created', campaign: campaignRow(row) };
}

async function sendCampaign(actor, req, id) {
  const campaignId = toId(id, 'campaign');
  const row = await one(
    admin.from('notification_campaigns').select('*').eq('id', campaignId).maybeSingle(),
    'Could not load that campaign'
  );
  if (!row) throw ApiError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
  if (row.status === 'sent') throw ApiError.conflict('CAMPAIGN_SENT', 'This campaign has already been sent');
  if (row.status === 'sending') throw ApiError.conflict('CAMPAIGN_SENDING', 'This campaign is already sending');

  await admin.from('notification_campaigns').update({ status: 'sending', error: null }).eq('id', campaignId);

  let recipients = 0;
  try {
    if (row.audience === 'all') {
      recipients = await notificationService.broadcast({
        type: row.type,
        title: row.title,
        description: row.body,
        rewardCoins: row.reward_coins
      });
    } else {
      const ids = await audienceIds(row.audience, row.audience_ids);
      for (let index = 0; index < ids.length; index += 400) {
        const chunk = ids.slice(index, index + 400);
        recipients += await notificationService.createMany(chunk, {
          type: row.type,
          title: row.title,
          description: row.body,
          rewardCoins: row.reward_coins
        });
      }
    }
    await one(
      admin
        .from('notification_campaigns')
        .update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: recipients, error: null })
        .eq('id', campaignId)
        .select('id')
        .single(),
      'Could not finish the campaign'
    );
  } catch (error) {
    await admin
      .from('notification_campaigns')
      .update({ status: 'failed', error: String(error.message || 'Delivery failed').slice(0, 500) })
      .eq('id', campaignId);
    throw error;
  }

  await audit.record(actor, 'notification.campaign.send', {
    targetType: 'campaign',
    targetId: campaignId,
    details: { recipients, audience: row.audience },
    req
  });
  return { message: `Campaign delivered to ${recipients.toLocaleString()} players`, recipients };
}

async function cancelCampaign(actor, req, id) {
  const campaignId = toId(id, 'campaign');
  const row = await one(
    admin
      .from('notification_campaigns')
      .update({ status: 'cancelled' })
      .eq('id', campaignId)
      .in('status', ['draft', 'scheduled', 'failed'])
      .select('id, name')
      .maybeSingle(),
    'Could not cancel the campaign'
  );
  if (!row) throw ApiError.notFound('CAMPAIGN_NOT_CANCELLABLE', 'That campaign is not awaiting delivery');
  await audit.record(actor, 'notification.campaign.cancel', { targetType: 'campaign', targetId: campaignId, details: { name: row.name }, req });
  return { message: 'Campaign cancelled' };
}

async function deleteCampaign(actor, req, id) {
  const campaignId = toId(id, 'campaign');
  const row = await one(admin.from('notification_campaigns').select('id, status').eq('id', campaignId).maybeSingle(), 'Could not load that campaign');
  if (!row) throw ApiError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
  if (row.status === 'sending') throw ApiError.conflict('CAMPAIGN_SENDING', 'This campaign is currently sending');
  await one(admin.from('notification_campaigns').delete().eq('id', campaignId).select('id'), 'Could not delete the campaign');
  await audit.record(actor, 'notification.campaign.delete', { targetType: 'campaign', targetId: campaignId, req });
  return { message: 'Campaign deleted' };
}

async function testNotification(actor, req, { title, body, type, reward_coins: rewardCoins } = {}) {
  const cleanTitle = cleanText(title, 120) || 'Test notification';
  const cleanBody = cleanMultiline(body, 1000) || 'This is a test from the admin console.';
  await notificationService.create({
    userId: actor.id,
    type: NOTIFICATION_TYPES.has(type) ? type : 'system',
    title: cleanTitle,
    description: cleanBody,
    rewardCoins: Math.min(Math.max(Number(rewardCoins) || 0, 0), 1000000)
  });
  await audit.record(actor, 'notification.test', { targetType: 'user', targetId: actor.id, req });
  return { message: 'Test notification delivered to your account' };
}

async function listNotificationHistory(query = {}) {
  const params = listParams(query, 20);
  const rows = await many(
    admin
      .from('notification_campaigns')
      .select('id, name, title, body, audience, status, scheduled_at, sent_at, recipient_count, error, created_at')
      .in('status', ['sent', 'failed', 'cancelled'])
      .order('created_at', { ascending: false })
      .limit(params.limit),
    'Could not load notification history'
  );
  return { history: rows, limit: params.limit };
}

/* Templates */

async function listTemplates() {
  const rows = await many(
    admin
      .from('notification_templates')
      .select('id, name, type, title, body, action_data, reward_coins, created_at, updated_at')
      .order('name', { ascending: true }),
    'Could not load notification templates'
  );
  return { templates: rows };
}

async function saveTemplate(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'template') : null;
  const name = cleanText(input.name, 80);
  const title = cleanText(input.title, 120);
  const body = cleanMultiline(input.body, 2000);
  if (name.length < 2) throw ApiError.badRequest('INVALID_NAME', 'Give the template a name');
  if (title.length < 2 || body.length < 3) throw ApiError.badRequest('INVALID_TEMPLATE', 'Add a title and body');
  const payload = {
    name,
    type: NOTIFICATION_TYPES.has(input.type) ? input.type : 'system',
    title,
    body,
    reward_coins: Math.min(Math.max(Number(input.reward_coins) || 0, 0), 1000000),
    action_data: input.action_data && typeof input.action_data === 'object' ? input.action_data : null
  };
  if (id) {
    const row = await one(
      admin.from('notification_templates').update(payload).eq('id', id).select('*').single(),
      'Could not update the template'
    );
    await audit.record(actor, 'notification.template.update', { targetType: 'template', targetId: id, details: { name }, req });
    return { message: 'Template saved', template: row };
  }
  const row = await one(
    admin
      .from('notification_templates')
      .insert({ ...payload, created_by: actor.id })
      .select('*')
      .single(),
    'Could not create the template'
  );
  await audit.record(actor, 'notification.template.create', { targetType: 'template', targetId: row.id, details: { name }, req });
  return { message: 'Template created', template: row };
}

async function deleteTemplate(actor, req, id) {
  const templateId = toId(id, 'template');
  await one(admin.from('notification_templates').delete().eq('id', templateId).select('id'), 'Could not delete the template');
  await audit.record(actor, 'notification.template.delete', { targetType: 'template', targetId: templateId, req });
  return { message: 'Template deleted' };
}

// 

const TICKET_COLUMNS =
  'id, user_id, name, email, subject, message, status, priority, category, assigned_to, assigned_at, first_response_at, last_reply_at, resolved_at, resolution_note, created_at, updated_at';

function ticketRow(row) {
  return {
    ...row,
    player: row.player || null,
    assignee: row.assignee || null
  };
}

async function listTickets(query = {}) {
  const params = listParams(query, 25);
  const status = TICKET_STATUSES.has(query.status) ? query.status : null;
  const priority = TICKET_PRIORITIES.has(query.priority) ? query.priority : null;
  const category = ['general', 'technical', 'payment', 'account', 'fair_play', 'other'].includes(query.category)
    ? query.category
    : null;
  const assigned = query.assigned === 'me' ? Number(query.adminId) : query.assigned === 'unassigned' ? null : null;
  const term = searchTerm(query.q);

  let base = admin
    .from('support_tickets')
    .select(
      `${TICKET_COLUMNS}, player:users!support_tickets_user_id_fkey(id, username, avatar_emoji, avatar_url), assignee:users!support_tickets_assigned_to_fkey(id, username)`,
      { count: 'exact' }
    );
  if (status) base = base.eq('status', status);
  if (priority) base = base.eq('priority', priority);
  if (category) base = base.eq('category', category);
  if (query.assigned === 'unassigned') base = base.is('assigned_to', null);
  else if (query.assigned === 'me' && assigned) base = base.eq('assigned_to', assigned);
  if (term) base = base.or(`name.ilike.%${term}%,email.ilike.%${term}%,subject.ilike.%${term}%,message.ilike.%${term}%`);

  const { data, error, count: total } = await base
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load support tickets');

  const result = pageResult((data || []).map(ticketRow), total, params);
  result.counts = await ticketCounts();
  return result;
}

async function ticketCounts() {
  const [open, inProgress, closed, urgent] = await Promise.all([
    count(admin.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open')).catch(() => 0),
    count(admin.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'in_progress')).catch(() => 0),
    count(admin.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'closed')).catch(() => 0),
    count(admin.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'in_progress']).eq('priority', 'urgent')).catch(() => 0)
  ]);
  return { open, inProgress, closed, urgent };
}

async function ticketDetail(id) {
  const ticketId = toId(id, 'ticket');
  const row = await one(
    admin
      .from('support_tickets')
      .select(
        `${TICKET_COLUMNS}, player:users!support_tickets_user_id_fkey(id, username, avatar_emoji, avatar_url, email, level, created_at), assignee:users!support_tickets_assigned_to_fkey(id, username)`
      )
      .eq('id', ticketId)
      .maybeSingle(),
    'Could not load that ticket'
  );
  if (!row) throw ApiError.notFound('TICKET_NOT_FOUND', 'Ticket not found');
  const replies = await many(
    admin
      .from('support_ticket_replies')
      .select('id, ticket_id, author_id, author_type, message, is_internal, created_at, author:users(id, username, avatar_emoji)')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true }),
    'Could not load replies'
  );
  return { ticket: ticketRow(row), replies };
}

async function replyTicket(actor, req, id, { message, internal } = {}) {
  const ticketId = toId(id, 'ticket');
  const text = cleanMultiline(message, 5000);
  if (text.length < 2) throw ApiError.badRequest('EMPTY_REPLY', 'Write a reply first');
  const ticket = await one(admin.from('support_tickets').select(TICKET_COLUMNS).eq('id', ticketId).maybeSingle(), 'Could not load that ticket');
  if (!ticket) throw ApiError.notFound('TICKET_NOT_FOUND', 'Ticket not found');
  if (ticket.status === 'closed') throw ApiError.badRequest('TICKET_CLOSED', 'Reopen the ticket before replying');

  const isInternal = Boolean(internal);
  const row = await one(
    admin
      .from('support_ticket_replies')
      .insert({
        ticket_id: ticketId,
        author_id: actor.id,
        author_type: 'admin',
        message: text,
        is_internal: isInternal
      })
      .select('id, ticket_id, author_id, author_type, message, is_internal, created_at')
      .single(),
    'Could not save the reply'
  );

  const now = new Date().toISOString();
  await one(
    admin
      .from('support_tickets')
      .update({
        status: ticket.status === 'open' ? 'in_progress' : ticket.status,
        first_response_at: ticket.first_response_at || (isInternal ? null : now),
        last_reply_at: now,
        assigned_to: ticket.assigned_to || actor.id,
        assigned_at: ticket.assigned_at || now
      })
      .eq('id', ticketId)
      .select('id')
      .single(),
    'Could not update the ticket'
  );

  if (!isInternal && ticket.user_id) {
    await notify(ticket.user_id, {
      type: 'system',
      title: `Reply to your support ticket${ticket.subject ? `: ${ticket.subject}` : ''}`,
      description: text
    });
  }
  await audit.record(actor, 'support.reply', {
    targetType: 'ticket',
    targetId: ticketId,
    details: { internal: isInternal },
    req
  });
  return { message: isInternal ? 'Internal note added' : 'Reply sent', reply: row };
}

async function updateTicket(actor, req, id, patch = {}) {
  const ticketId = toId(id, 'ticket');
  const ticket = await one(admin.from('support_tickets').select(TICKET_COLUMNS).eq('id', ticketId).maybeSingle(), 'Could not load that ticket');
  if (!ticket) throw ApiError.notFound('TICKET_NOT_FOUND', 'Ticket not found');

  const update = {};
  if (patch.status !== undefined) {
    if (!TICKET_STATUSES.has(patch.status)) throw ApiError.badRequest('INVALID_STATUS', 'Choose a valid ticket status');
    update.status = patch.status;
    update.resolved_at = patch.status === 'closed' ? new Date().toISOString() : null;
  }
  if (patch.priority !== undefined) {
    if (!TICKET_PRIORITIES.has(patch.priority)) throw ApiError.badRequest('INVALID_PRIORITY', 'Choose a valid priority');
    update.priority = patch.priority;
  }
  if (patch.category !== undefined) {
    const categories = ['general', 'technical', 'payment', 'account', 'fair_play', 'other'];
    if (!categories.includes(patch.category)) throw ApiError.badRequest('INVALID_CATEGORY', 'Choose a valid category');
    update.category = patch.category;
  }
  if (patch.assigned_to !== undefined) {
    if (patch.assigned_to === null || patch.assigned_to === '') {
      update.assigned_to = null;
      update.assigned_at = null;
    } else {
      update.assigned_to = toId(patch.assigned_to, 'administrator');
      update.assigned_at = new Date().toISOString();
    }
  }
  if (patch.resolution_note !== undefined) update.resolution_note = cleanMultiline(patch.resolution_note, 2000);
  if (!Object.keys(update).length) throw ApiError.badRequest('NO_CHANGES', 'No ticket fields were supplied');

  const row = await one(
    admin.from('support_tickets').update(update).eq('id', ticketId).select(TICKET_COLUMNS).single(),
    'Could not update the ticket'
  );
  if (update.status === 'closed' && ticket.user_id) {
    await notify(ticket.user_id, {
      type: 'system',
      title: 'Support ticket resolved',
      description: update.resolution_note || 'Your support ticket has been closed. Reply if you still need help.'
    });
  }
  await audit.record(actor, 'support.update', {
    targetType: 'ticket',
    targetId: ticketId,
    details: { fields: Object.keys(update), status: update.status },
    req
  });
  return { message: 'Ticket updated', ticket: row };
}

async function supportAnalytics(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 30, 7), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await many(
    admin
      .from('support_tickets')
      .select('id, status, priority, category, assigned_to, created_at, first_response_at, resolved_at')
      .gte('created_at', since)
      .limit(5000),
    'Could not analyse support performance'
  ).catch(() => []);
  const agents = new Map();
  const categories = new Map();
  let firstResponseTotal = 0;
  let firstResponseCount = 0;
  let resolutionTotal = 0;
  let resolutionCount = 0;
  rows.forEach((row) => {
    const agent = row.assigned_to ? String(row.assigned_to) : 'unassigned';
    const entry = agents.get(agent) || { assigned: 0, closed: 0, firstResponse: 0, firstResponseCount: 0 };
    entry.assigned += 1;
    if (row.status === 'closed') entry.closed += 1;
    if (row.first_response_at) {
      const seconds = (new Date(row.first_response_at) - new Date(row.created_at)) / 1000;
      if (seconds >= 0) {
        entry.firstResponse += seconds;
        entry.firstResponseCount += 1;
        firstResponseTotal += seconds;
        firstResponseCount += 1;
      }
    }
    agents.set(agent, entry);
    const category = row.category || 'general';
    categories.set(category, (categories.get(category) || 0) + 1);
    if (row.resolved_at) {
      const seconds = (new Date(row.resolved_at) - new Date(row.created_at)) / 1000;
      if (seconds >= 0) {
        resolutionTotal += seconds;
        resolutionCount += 1;
      }
    }
  });
  return {
    range: { days, since },
    tickets: rows.length,
    open: rows.filter((row) => row.status !== 'closed').length,
    avgFirstResponseMinutes: firstResponseCount ? Math.round(firstResponseTotal / firstResponseCount / 60) : null,
    avgResolutionMinutes: resolutionCount ? Math.round(resolutionTotal / resolutionCount / 60) : null,
    categories: [...categories.entries()].map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value),
    agents: [...agents.entries()].map(([agentId, value]) => ({
      agentId: agentId === 'unassigned' ? null : Number(agentId),
      ...value,
      avgFirstResponseMinutes: value.firstResponseCount ? Math.round(value.firstResponse / value.firstResponseCount / 60) : null
    }))
  };
}

// 

function normaliseBlocks(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 120).map((block) => {
    const type = BLOCK_TYPES.has(block?.type) ? block.type : 'paragraph';
    const clean = { type };
    if (type === 'heading') {
      clean.text = cleanText(block.text, 160);
      clean.level = Number(block.level) === 1 ? 1 : 2;
    } else if (type === 'list') {
      clean.items = Array.isArray(block.items)
        ? block.items.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 40)
        : [];
    } else if (type === 'quote') {
      clean.text = cleanText(block.text, 1000);
      clean.cite = cleanText(block.cite, 120);
    } else if (type === 'cta') {
      clean.text = cleanText(block.text, 120);
      clean.label = cleanText(block.label, 60);
      clean.href = safeLinkHref(block.href);
    } else if (type === 'image') {
      clean.url = safeHref(block.url);
      clean.alt = cleanText(block.alt, 200);
      clean.caption = cleanText(block.caption, 300);
    } else {
      clean.text = cleanMultiline(block.text, 8000);
    }
    return clean;
  }).filter((block) => {
    if (block.type === 'list') return block.items.length;
    if (block.type === 'image') return Boolean(block.url);
    return Boolean(block.text);
  });
}

function safeHref(value) {
  const text = String(value || '').trim().slice(0, 1000);
  if (!text) return '';
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  if (/^https:\/\//i.test(text)) return text;
  return '';
}

// Validate content block links
function safeLinkHref(value) {
  const text = String(value || '').trim().slice(0, 1000);
  if (!text) return '';
  if (safeHref(text)) return text;
  if (text.includes('..') || text.includes('\\') || text.startsWith('//')) return '';
  return /^[a-z0-9][a-z0-9._~/-]*$/i.test(text) ? text : '';
}

function pageRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content || { blocks: [] },
    status: row.status,
    seo_title: row.seo_title || '',
    seo_description: row.seo_description || '',
    og_image: row.og_image || '',
    canonical_url: row.canonical_url || '',
    no_index: Boolean(row.no_index),
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listPages(query = {}) {
  const params = listParams(query, 25);
  const status = PAGE_STATUSES.has(query.status) ? query.status : null;
  const term = searchTerm(query.q);
  let base = admin
    .from('cms_pages')
    .select('id, slug, title, excerpt, content, status, seo_title, seo_description, og_image, canonical_url, no_index, published_at, created_at, updated_at', { count: 'exact' });
  if (status) base = base.eq('status', status);
  if (term) base = base.or(`title.ilike.%${term}%,slug.ilike.%${term}%`);
  const { data, error, count: total } = await base
    .order('updated_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load content pages');
  return pageResult((data || []).map(pageRow), total, params);
}

async function pageDetail(id) {
  const pageId = toId(id, 'page');
  const row = await one(admin.from('cms_pages').select('*').eq('id', pageId).maybeSingle(), 'Could not load that page');
  if (!row) throw ApiError.notFound('PAGE_NOT_FOUND', 'Page not found');
  return { page: pageRow(row) };
}

async function savePage(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'page') : null;
  const slug = String(input.slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  if (!slug || slug === 'admin' || slug.startsWith('admin/')) {
    throw ApiError.badRequest('INVALID_SLUG', 'Choose a valid page slug');
  }
  const title = cleanText(input.title, 140);
  if (title.length < 2) throw ApiError.badRequest('INVALID_TITLE', 'Give the page a title');
  const status = PAGE_STATUSES.has(input.status) ? input.status : 'draft';
  const content = { blocks: normaliseBlocks(input.content?.blocks || input.blocks) };
  let publishedAt = status === 'published' ? new Date().toISOString() : null;
  if (id && status === 'published') {
    const existing = await one(
      admin.from('cms_pages').select('published_at').eq('id', id).maybeSingle(),
      'Could not load that page'
    );
    publishedAt = existing?.published_at || publishedAt;
  }
  const payload = {
    slug,
    title,
    excerpt: cleanText(input.excerpt, 400),
    content,
    status,
    seo_title: cleanText(input.seo_title, 80),
    seo_description: cleanText(input.seo_description, 320),
    og_image: safeHref(input.og_image),
    canonical_url: safeHref(input.canonical_url),
    no_index: Boolean(input.no_index),
    published_at: publishedAt,
    updated_by: actor.id
  };

  try {
    if (id) {
      const row = await one(
        admin.from('cms_pages').update(payload).eq('id', id).select('*').single(),
        'Could not save the page'
      );
      await audit.record(actor, 'cms.page.update', {
        targetType: 'cms_page',
        targetId: id,
        details: { slug, status, blocks: content.blocks.length },
        req
      });
      return { message: 'Page saved', page: pageRow(row) };
    }
    const row = await one(
      admin
        .from('cms_pages')
        .insert({ ...payload, created_by: actor.id })
        .select('*')
        .single(),
      'Could not create the page'
    );
    await audit.record(actor, 'cms.page.create', { targetType: 'cms_page', targetId: row.id, details: { slug }, req });
    return { message: 'Page created', page: pageRow(row) };
  } catch (error) {
    if (String(error.code || '').includes('23505') || /duplicate key/i.test(String(error.message))) {
      throw ApiError.conflict('SLUG_TAKEN', 'Another page already uses that slug');
    }
    throw error;
  }
}

async function deletePage(actor, req, id) {
  const pageId = toId(id, 'page');
  const row = await one(admin.from('cms_pages').select('id, slug, title').eq('id', pageId).maybeSingle(), 'Could not load that page');
  if (!row) throw ApiError.notFound('PAGE_NOT_FOUND', 'Page not found');
  await one(admin.from('cms_pages').delete().eq('id', pageId).select('id'), 'Could not delete the page');
  await audit.record(actor, 'cms.page.delete', { targetType: 'cms_page', targetId: pageId, details: { slug: row.slug }, req });
  return { message: 'Page deleted' };
}

async function listRedirects(query = {}) {
  const params = listParams(query, 50);
  const { data, error, count: total } = await admin
    .from('cms_redirects')
    .select('id, from_path, to_path, status_code, is_active, hits, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(params.from, params.to);
  if (error) throw new ApiError(502, 'DATABASE_ERROR', 'Could not load redirects');
  return pageResult(data || [], total, params);
}

async function saveRedirect(actor, req, input = {}) {
  const id = input.id ? toId(input.id, 'redirect') : null;
  const fromPath = normalisePath(input.from_path);
  const toPath = safeHref(input.to_path);
  if (!fromPath) throw ApiError.badRequest('INVALID_PATH', 'Enter the path to redirect from');
  if (!toPath) throw ApiError.badRequest('INVALID_TARGET', 'Enter a same-site path or an https URL');
  if (fromPath === toPath) throw ApiError.badRequest('REDIRECT_LOOP', 'The source and destination are the same');
  const statusCode = [301, 302, 307, 308].includes(Number(input.status_code)) ? Number(input.status_code) : 301;

  try {
    const payload = { from_path: fromPath, to_path: toPath, status_code: statusCode, is_active: input.is_active !== false };
    if (id) {
      const row = await one(admin.from('cms_redirects').update(payload).eq('id', id).select('*').single(), 'Could not save the redirect');
      await audit.record(actor, 'cms.redirect.update', { targetType: 'cms_redirect', targetId: id, details: payload, req });
      return { message: 'Redirect saved', redirect: row };
    }
    const row = await one(
      admin.from('cms_redirects').insert({ ...payload, created_by: actor.id }).select('*').single(),
      'Could not create the redirect'
    );
    await audit.record(actor, 'cms.redirect.create', { targetType: 'cms_redirect', targetId: row.id, details: payload, req });
    return { message: 'Redirect created', redirect: row };
  } catch (error) {
    if (String(error.code || '').includes('23505') || /duplicate key/i.test(String(error.message))) {
      throw ApiError.conflict('REDIRECT_EXISTS', 'A redirect already exists for that path');
    }
    throw error;
  }
}

function normalisePath(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('/')) return '';
  if (text.startsWith('//')) return '';
  if (text.toLowerCase().startsWith('/admin')) return '';
  return text.slice(0, 500);
}

async function deleteRedirect(actor, req, id) {
  const redirectId = toId(id, 'redirect');
  await one(admin.from('cms_redirects').delete().eq('id', redirectId).select('id'), 'Could not delete the redirect');
  await audit.record(actor, 'cms.redirect.delete', { targetType: 'cms_redirect', targetId: redirectId, req });
  return { message: 'Redirect deleted' };
}

async function getSeo() {
  const [seo, branding, structuredData] = await Promise.all([
    settingsService.seo(),
    settingsService.branding(),
    settingsService.get('structured_data', {})
  ]);
  return { seo, branding, structuredData: structuredData || {} };
}

async function saveSeo(actor, req, { seo, branding, structuredData } = {}) {
  const saved = {};
  if (seo) {
    const row = await settingsService.set(actor, 'seo', seo, { req });
    saved.seo = row.value;
  }
  if (branding) {
    const row = await settingsService.set(actor, 'branding', branding, { req });
    saved.branding = row.value;
  }
  if (structuredData) {
    const row = await settingsService.set(actor, 'structured_data', structuredData, { req });
    saved.structuredData = row.value;
  }
  if (!Object.keys(saved).length) throw ApiError.badRequest('NO_CHANGES', 'No SEO settings were supplied');
  return { message: 'SEO and branding saved', ...saved };
}

/* Public read model */

async function publicSite() {
  const [seo, branding, version, maintenance, flags, structuredData] = await Promise.all([
    settingsService.seo().catch(() => ({})),
    settingsService.branding().catch(() => ({})),
    settingsService.version().catch(() => null),
    settingsService.maintenance().catch(() => ({ enabled: false })),
    many(admin.from('feature_flags').select('key, enabled'), 'Could not load flags').catch(() => []),
    settingsService.get('structured_data', {}).catch(() => ({}))
  ]);
  return {
    seo: { ...seo, indexingEnabled: seo?.indexingEnabled !== false },
    branding,
    structuredData: structuredData || {},
    version,
    maintenance,
    flags: Object.fromEntries((flags || []).map((row) => [row.key, Boolean(row.enabled)])),
    generatedAt: new Date().toISOString()
  };
}

async function publicPage(slug) {
  const cleanSlug = String(slug || '').trim().toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleanSlug || cleanSlug.length > 80) throw ApiError.notFound('PAGE_NOT_FOUND', 'Page not found');
  const row = await one(
    admin.from('cms_pages').select('*').ilike('slug', cleanSlug).eq('status', 'published').maybeSingle(),
    'Could not load the page'
  );
  if (!row) throw ApiError.notFound('PAGE_NOT_FOUND', 'Page not found');
  return { page: pageRow(row) };
}

async function publicRedirects() {
  const rows = await many(
    admin
      .from('cms_redirects')
      .select('from_path, to_path, status_code')
      .eq('is_active', true)
      .limit(1000),
    'Could not load redirects'
  ).catch(() => []);
  return {
    redirects: rows.map((row) => ({
      from: row.from_path,
      to: row.to_path,
      status: row.status_code
    }))
  };
}

async function sitemap() {
  const [seo, pages] = await Promise.all([settingsService.seo().catch(() => ({})), listPages({ status: 'published', limit: 100 })]);
  const base = String(seo.canonicalBase || env.siteUrl || '').replace(/\/$/, '');
  if (seo.indexingEnabled === false) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';
  }
  const urls = new Map(STATIC_PAGES.map(([slug, path]) => [path, { loc: `${base}${path}`, priority: slug === 'home' ? '1.0' : slug === 'leaderboard' ? '0.9' : '0.7' }]));
  pages.rows.forEach((page) => {
    if (page.no_index || page.status !== 'published' || !PUBLIC_PAGE_SLUGS.has(page.slug)) return;
    const path = `/${page.slug}`;
    if (RESTRICTED_PATHS.some((restricted) => path === restricted || path.startsWith(`${restricted}/`))) return;
    urls.set(path, { loc: `${base}${path}`, priority: '0.6', lastmod: page.updated_at });
  });
  const body = [...urls.values()]
    .map((entry) => `  <url><loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>` : ''}<priority>${entry.priority}</priority></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

async function robots() {
  const seo = await settingsService.seo().catch(() => ({}));
  const base = String(seo.canonicalBase || env.siteUrl || '').replace(/\/$/, '');
  if (seo.indexingEnabled === false) return 'User-agent: *\nDisallow: /\n';
  const extra = String(seo.robotsExtra || '').trim();
  const disallow = RESTRICTED_PATHS.map((path) => `Disallow: ${path}`).join('\n');
  return `User-agent: *\nAllow: /\n${disallow}\nSitemap: ${base}/sitemap.xml\n${extra ? `${extra}\n` : ''}`;
}

async function seoAudit() {
  const [seo, pages] = await Promise.all([
    settingsService.seo().catch(() => ({})),
    listPages({ status: 'published', limit: 100 })
  ]);
  const bySlug = new Map(pages.rows.map((page) => [page.slug, page]));
  const base = String(seo.canonicalBase || env.siteUrl || '').replace(/\/$/, '');
  const routes = STATIC_PAGES.map(([slug, path]) => {
    const page = bySlug.get(slug);
    const def = STATIC_PAGE_DEFAULTS[slug] || {};
    const title = String(page?.seo_title || page?.title || def.title || '').trim();
    const description = String(page?.seo_description || page?.excerpt || def.description || '').trim();
    const canonical = page?.canonical_url || (base ? `${base}${path}` : '');
    const noIndex = Boolean(page?.no_index) || seo.indexingEnabled === false;
    return { slug, path, title, description, canonical, noIndex, source: page ? 'cms' : 'static' };
  });

  const issues = [];
  if (!String(seo.siteTitle || '').trim()) issues.push({ level: 'error', field: 'siteTitle', message: 'Global site title is missing.' });
  if (!String(seo.description || '').trim()) issues.push({ level: 'error', field: 'description', message: 'Global meta description is missing.' });
  if (!base) issues.push({ level: 'error', field: 'canonicalBase', message: 'Canonical base URL is missing; canonical tags and sitemap URLs will be disabled.' });
  if (!String(seo.faviconUrl || '').trim()) issues.push({ level: 'warning', field: 'faviconUrl', message: 'Favicon URL is not configured.' });
  if (!String(seo.ogImage || '').trim()) issues.push({ level: 'warning', field: 'ogImage', message: 'Open Graph image is not configured; social cards will use a summary card.' });

  const titleCounts = new Map();
  const descriptionCounts = new Map();
  routes.forEach((route) => {
    if (!route.title) issues.push({ level: 'error', page: route.path, message: 'Page title is missing.' });
    if (!route.description) issues.push({ level: 'warning', page: route.path, message: 'Meta description is missing.' });
    if (!route.canonical) issues.push({ level: 'warning', page: route.path, message: 'Canonical URL cannot be generated.' });
    if (route.noIndex) issues.push({ level: 'warning', page: route.path, message: 'Page is excluded from indexing.' });
    if (route.title) titleCounts.set(route.title, (titleCounts.get(route.title) || 0) + 1);
    if (route.description) descriptionCounts.set(route.description, (descriptionCounts.get(route.description) || 0) + 1);
  });
  routes.forEach((route) => {
    if (titleCounts.get(route.title) > 1) issues.push({ level: 'warning', page: route.path, message: 'Duplicate page title.' });
    if (descriptionCounts.get(route.description) > 1) issues.push({ level: 'warning', page: route.path, message: 'Duplicate meta description.' });
  });

  return {
    routes,
    issues,
    summary: {
      pages: routes.length,
      indexable: routes.filter((route) => !route.noIndex).length,
      errors: issues.filter((issue) => issue.level === 'error').length,
      warnings: issues.filter((issue) => issue.level === 'warning').length
    }
  };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function sitemapStats() {
  const [seo, pages, redirects] = await Promise.all([
    settingsService.seo().catch(() => ({})),
    count(admin.from('cms_pages').select('id', { count: 'exact', head: true }).eq('status', 'published').eq('no_index', false)).catch(() => 0),
    count(admin.from('cms_redirects').select('id', { count: 'exact', head: true }).eq('is_active', true)).catch(() => 0)
  ]);
  return {
    canonicalBase: seo.canonicalBase || env.siteUrl || '',
    indexingEnabled: seo.indexingEnabled !== false,
    publishedPages: pages,
    activeRedirects: redirects,
    sitemapUrl: `${String(seo.canonicalBase || env.siteUrl || '').replace(/\/$/, '')}/sitemap.xml`,
    robotsUrl: `${String(seo.canonicalBase || env.siteUrl || '').replace(/\/$/, '')}/robots.txt`
  };
}

module.exports = {
  pushStatus,
  notificationOverview,
  listCampaigns,
  audienceCount,
  saveCampaign,
  sendCampaign,
  cancelCampaign,
  deleteCampaign,
  testNotification,
  listNotificationHistory,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  listTickets,
  ticketDetail,
  replyTicket,
  updateTicket,
  supportAnalytics,
  listPages,
  pageDetail,
  savePage,
  deletePage,
  listRedirects,
  saveRedirect,
  deleteRedirect,
  getSeo,
  saveSeo,
  publicSite,
  publicPage,
  publicRedirects,
  sitemap,
  robots,
  sitemapStats,
  seoAudit
};
