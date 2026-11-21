'use strict';

const { cloudinary, assertConfigured } = require('../config/cloudinary');
const { ApiError } = require('../utils/ApiError');

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function validateImage(file) {
  if (!file) throw ApiError.badRequest('IMAGE_REQUIRED', 'Choose an image to upload');
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    throw ApiError.badRequest('INVALID_IMAGE_TYPE', 'Upload a PNG, JPEG, WEBP or GIF image');
  }
  return file;
}

function uploadBuffer(buffer, { folder, resourceType = 'image' } = {}) {
  assertConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || 'tictacarena',
        resource_type: resourceType,
        transformation: [{ quality: 'auto', fetch_format: 'auto' }]
      },
      (error, result) => {
        if (error) {
          reject(new ApiError(502, 'UPLOAD_FAILED', 'Could not upload the image'));
        } else {
          resolve(result);
        }
      }
    );
    stream.end(buffer);
  });
}

async function uploadImage(file, { folder } = {}) {
  validateImage(file);
  const result = await uploadBuffer(file.buffer, { folder });
  return {
    url: result.secure_url,
    public_id: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format
  };
}

async function destroy(publicId) {
  if (!publicId) return;
  try {
    assertConfigured();
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.warn('[upload] Cloudinary destroy failed:', error.message);
  }
}

module.exports = { uploadImage, destroy, validateImage };
