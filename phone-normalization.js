(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TZPhone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Canonical form: 9647XXXXXXXXX (country code plus the ten-digit Iraqi mobile number).
  // Accepted input: 07XXXXXXXXX, 9647XXXXXXXXX, +9647XXXXXXXXX, or 009647XXXXXXXXX.
  function normalizeIraqiMobile(input) {
    if (typeof input !== 'string' && typeof input !== 'number') return null;
    const raw = String(input).trim();
    if (!raw || !/^\+?[0-9\s().-]+$/.test(raw)) return null;

    const digits = raw.replace(/[\s().-]/g, '').replace(/^\+/, '');
    let national;
    if (/^07[0-9]{9}$/.test(digits)) {
      national = digits.slice(1);
    } else if (/^9647[0-9]{9}$/.test(digits)) {
      national = digits.slice(3);
    } else if (/^009647[0-9]{9}$/.test(digits)) {
      national = digits.slice(5);
    } else {
      return null;
    }
    return `964${national}`;
  }

  return Object.freeze({ normalizeIraqiMobile });
});
