'use strict';

const { admin, one, many } = require('../utils/db');
const { cleanText, cleanMultiline } = require('../utils/sanitize');
const { ApiError } = require('../utils/ApiError');

async function create(user, input) {
  const row = await one(
    admin
      .from('support_tickets')
      .insert({
        user_id: user?.id || null,
        name: cleanText(input.name, 80) || 'Player',
        email: String(input.email).trim().toLowerCase(),
        message: cleanMultiline(input.message, 5000)
      })
      .select('id, status, created_at')
      .single(),
    'Could not submit your message'
  );
  return {
    message: "Message sent! We'll reply within 4 hours.",
    ticket: row
  };
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

module.exports = { create, notify, list, updateStatus };
