'use strict';

const matchService = require('../services/match.service');

async function history(req, res) {
  res.json(await matchService.history(req.user, req.query));
}

async function detail(req, res) {
  res.json(await matchService.getMatch(req.user, req.params.id));
}

async function training(req, res) {
  res.status(201).json(await matchService.trainingResult(req.user, req.body));
}

async function stats(req, res) {
  res.json(await matchService.stats(req.user));
}

module.exports = { history, detail, training, stats };
