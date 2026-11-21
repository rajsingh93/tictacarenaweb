'use strict';

const operations = require('../services/operations.service');

async function list(req, res) {
  res.json(await operations.listTournamentsForPlayer(req.user));
}

async function join(req, res) {
  res.json(await operations.joinTournament(req.user, req.params.id));
}

async function leave(req, res) {
  res.json(await operations.leaveTournament(req.user, req.params.id));
}

module.exports = { list, join, leave };
