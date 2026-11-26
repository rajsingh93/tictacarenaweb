'use strict';

const { admin, one, many } = require('../utils/db');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { ApiError } = require('../utils/ApiError');

const CATEGORIES = new Set(['general', 'technical', 'payment', 'account', 'fair_play', 'other']);

async function create(user, input) {
  const category = CATEGORIES.has(input.category) ? input.category : 'general';
  const message = cleanMultiline(input.message, 5000);
  const subject = cleanText(input.subject, 160) || cleanText(message, 80) || 'Player support request';
  const row = await one(
    admin
      .from('support_tickets')
      .insert({
        user_id: user?.id || null,
        name: cleanText(input.name, 80) || user?.username || 'Player',
        email: String(input.email).trim().toLowerCase(),
        subject,
        category,
        message
      })
      .select('id, status, subject, category, created_at')
      .single(),
    'Could not submit your message'
  );
  return {
    message: "Message sent! We'll reply within 4 hours.",
    ticket: row
  };
}

const PLAYER_TICKET_COLUMNS =
  'id, subject, category, status, priority, message, resolution_note, created_at, updated_at, last_reply_at';

async function listMine(user, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const tickets = await many(
    admin
      .from('support_tickets')
      .select(PLAYER_TICKET_COLUMNS)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(safeLimit),
    'Could not load your support requests'
  );
  return { tickets };
}

async function detailMine(user, id) {
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw ApiError.badRequest('INVALID_TICKET', 'Invalid support request');
  }
  const ticket = await one(
    admin
      .from('support_tickets')
      .select(PLAYER_TICKET_COLUMNS)
      .eq('id', ticketId)
      .eq('user_id', user.id)
      .maybeSingle(),
    'Could not load that support request'
  );
  if (!ticket) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support request not found');

  const replies = await many(
    admin
      .from('support_ticket_replies')
      .select('id, author_type, message, created_at')
      .eq('ticket_id', ticketId)
      .eq('is_internal', false)
      .order('created_at', { ascending: true }),
    'Could not load the conversation'
  );
  return { ticket, replies };
}

async function replyMine(user, id, { message } = {}) {
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw ApiError.badRequest('INVALID_TICKET', 'Invalid support request');
  }
  const text = cleanMultiline(message, 5000);
  if (text.length < 2) throw ApiError.badRequest('EMPTY_REPLY', 'Write a reply first');

  const ticket = await one(
    admin
      .from('support_tickets')
      .select('id, user_id, status')
      .eq('id', ticketId)
      .eq('user_id', user.id)
      .maybeSingle(),
    'Could not load that support request'
  );
  if (!ticket) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support request not found');
  if (ticket.status === 'closed') {
    throw ApiError.badRequest('TICKET_CLOSED', 'This request is closed. Open a new request to continue.');
  }

  const row = await one(
    admin
      .from('support_ticket_replies')
      .insert({
        ticket_id: ticketId,
        author_id: user.id,
        author_type: 'player',
        message: text,
        is_internal: false
      })
      .select('id, author_type, message, created_at')
      .single(),
    'Could not send your reply'
  );

  await one(
    admin
      .from('support_tickets')
      .update({ status: 'open', last_reply_at: new Date().toISOString(), resolved_at: null })
      .eq('id', ticketId)
      .select('id')
      .single(),
    'Could not update your support request'
  );

  return { message: 'Reply sent', reply: row };
}

async function notify(user, input) {
  const email = input.email || user?.email;
  const name = cleanText(input.name, 80) || user?.username || 'Player';
  if (!email) {
    throw ApiError.badRequest('EMAIL_REQUIRED', 'Enter an email address so we can notify you');
  }
  const existing = await one(
    admin
      .from('support_tickets')
      .select('id')
      .eq('email', String(email).toLowerCase())
      .eq('status', 'open')
      .ilike('message', '%maintenance%')
      .gte('created_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
      .maybeSingle(),
    'Could not check your notification request'
  );
  if (existing) return { message: "You're already on the list. We'll let you know!", ticket: existing };

  const ticket = await one(
    admin
      .from('support_tickets')
      .insert({
        user_id: user?.id || null,
        name,
        email: String(email).trim().toLowerCase(),
        message: 'Notify me when maintenance is finished.'
      })
      .select('id, status, created_at')
      .single(),
    'Could not save your request'
  );
  return { message: "We'll notify you when we're back online!", ticket };
}

// The moderation queue renders sender, message, status and date only.
const TICKET_COLUMNS = 'id, name, email, message, status, created_at';

async function list({ status, limit = 50 } = {}) {
  let query = admin
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  if (status) query = query.eq('status', status);
  return { tickets: await many(query, 'Could not load support tickets') };
}

async function updateStatus(id, status) {
  const ticket = await one(
    admin
      .from('support_tickets')
      .update({ status })
      .eq('id', id)
      .select(TICKET_COLUMNS)
      .maybeSingle(),
    'Could not update the ticket'
  );
  if (!ticket) throw ApiError.notFound('TICKET_NOT_FOUND', 'Ticket not found');
  return { message: 'Ticket updated', ticket };
}

module.exports = { create, notify, list, updateStatus, listMine, detailMine, replyMine };
