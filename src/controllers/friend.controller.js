'use strict';

const friendService = require('../services/friend.service');

async function list(req, res) {
  res.json(await friendService.listFriends(req.user));
}

async function requests(req, res) {
  res.json(await friendService.listRequests(req.user));
}

async function blocked(req, res) {
  res.json(await friendService.listBlocked(req.user));
}

async function request(req, res) {
  const target = await friendService.targetById(req.params.id);
  res.status(201).json(await friendService.sendRequest(req.user, target));
}

async function requestByUsername(req, res) {
  res.status(201).json(await friendService.sendRequestByUsername(req.user, req.body.username));
}

async function status(req, res) {
  res.json(await friendService.getRelationshipStatus(req.user, req.params.id));
}

async function accept(req, res) {
  res.json(await friendService.acceptRequest(req.user, req.params.id));
}

async function remove(req, res) {
  res.json(await friendService.removeFriend(req.user, req.params.id));
}

async function decline(req, res) {
  res.json(await friendService.declineRequest(req.user, req.params.id));
}

async function block(req, res) {
  res.json(await friendService.blockUser(req.user, req.params.id));
}

async function unblock(req, res) {
  res.json(await friendService.unblockUser(req.user, req.params.id));
}

module.exports = {
  list,
  requests,
  blocked,
  request,
  requestByUsername,
  status,
  accept,
  remove,
  decline,
  block,
  unblock
};
