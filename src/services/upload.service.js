'use strict';

const { cloudinary, assertConfigured } = require('../config/cloudinary');
const { ApiError } = require('../utils/ApiError');

const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// The browser-supplied MIME type is not trustworthy: a client can label any
// payload "image/png". Verify the file signature (magic bytes) as well before
// the buffer is forwarded to Cloudinary.
function signatureMatches(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const starts = (bytes) => bytes.every((value, index) => buffer[index] === value);
  const ascii = (start, length) => buffer.slice(start, start + length).toString('ascii');
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true; // PNG
  if (starts([0xff, 0xd8, 0xff])) return true; // JPEG
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return true; // GIF
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return true; // WEBP
  return false;
}

function validateImage(file) {
  if (!file) throw ApiError.badRequest('IMAGE_REQUIRED', 'Choose an image to upload');
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    throw ApiError.badRequest('INVALID_IMAGE_TYPE', 'Upload a PNG, JPEG, WEBP or GIF image');
  }
  if (!signatureMatches(file.buffer)) {
    throw ApiError.badRequest('INVALID_IMAGE_CONTENT', 'That file is not a valid image');
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
