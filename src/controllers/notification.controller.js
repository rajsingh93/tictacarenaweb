'use strict';

const notificationService = require('../services/notification.service');

async function list(req, res) {
  res.json(
    await notificationService.list(req.user.id, req.query.category, req.query.limit, req.query.offset, {
      withUnread: req.query.withUnread === '1'
    })
  );
}

async function unread(req, res) {
  res.json({ unread: await notificationService.unreadCount(req.user.id, req.query.category) });
}

async function sendMail(req, res) {
  res.status(201).json(await notificationService.sendUserMail(req.user, req.body));
}

async function read(req, res) {
  res.json(await notificationService.markRead(req.user.id, req.params.id));
}

async function readAll(req, res) {
  res.json(await notificationService.markAllRead(req.user.id, req.query.category));
}

async function remove(req, res) {
  res.json(await notificationService.remove(req.user.id, req.params.id));
}

async function claim(req, res) {
  res.json(await notificationService.claim(req.user.id, req.params.id));
}

module.exports = { list, unread, sendMail, read, readAll, remove, claim };
