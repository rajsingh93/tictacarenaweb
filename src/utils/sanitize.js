'use strict';

const xss = require('xss');

const strip = new xss.FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style']
});

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return '';
  let text = strip.process(String(value)).replace(/\s+/g, ' ').trim();
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength).trim();
  return text;
}

function cleanMultiline(value, maxLength) {
  if (value === null || value === undefined) return '';
  let text = strip.process(String(value)).replace(/\r\n/g, '\n').trim();
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength).trim();
  return text;
}

function countWords(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

module.exports = { cleanText, cleanMultiline, countWords };
