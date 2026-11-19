'use strict';

const chatService = require('../services/chat.service');

async function list(req, res) {
  res.json(await chatService.list(req.user));
}

async function worldHistory(req, res) {
  res.json(await chatService.world(req.query.limit, req.query.before));
}

async function conversation(req, res) {
  res.json(await chatService.conversation(req.user, req.params.friendId, { before: req.query.before }));
}

async function markRead(req, res) {
  res.json(await chatService.markRead(req.user, req.params.friendId));
}

module.exports = { list, worldHistory, conversation, markRead };
