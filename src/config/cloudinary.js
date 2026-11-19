'use strict';

const { v2: cloudinary } = require('cloudinary');
const env = require('./env');

cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
  secure: true
});

function assertConfigured() {
  if (!env.cloudinary.cloudName || !env.cloudinary.apiKey || !env.cloudinary.apiSecret) {
    const error = new Error('Cloudinary is not configured on the server');
    error.status = 503;
    error.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw error;
  }
}

module.exports = { cloudinary, assertConfigured };
