'use strict';

const shopService = require('../services/shop.service');

async function items(req, res) {
  res.json(await shopService.listItems(req.user, req.query.type));
}

async function owned(req, res) {
  res.json(await shopService.owned(req.user));
}

async function buy(req, res) {
  res.json(await shopService.buy(req.user, req.params.id));
}

async function equip(req, res) {
  res.json(await shopService.equip(req.user, req.params.id));
}

module.exports = { items, owned, buy, equip };
