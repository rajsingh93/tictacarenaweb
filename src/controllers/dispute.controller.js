'use strict';

const disputeService = require('../services/dispute.service');

async function list(req, res) {
  res.json(await disputeService.listMine(req.user));
}

async function create(req, res) {
  res.status(201).json(await disputeService.createForMatch(req.user, req.params.matchId, req.body));
}

module.exports = { list, create };
