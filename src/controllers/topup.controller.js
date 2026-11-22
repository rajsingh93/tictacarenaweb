'use strict';

const topupService = require('../services/topup.service');

async function packages(req, res) {
  res.json(await topupService.packages());
}

async function createOrder(req, res) {
  res.status(201).json(await topupService.createOrder(req.user, req.body));
}

async function orders(req, res) {
  res.json(await topupService.orders(req.user, req.query.limit));
}

async function webhook(req, res) {
  res.json(await topupService.webhook(req.body, req.headers['x-topup-secret']));
}

module.exports = { packages, createOrder, orders, webhook };
