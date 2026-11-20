(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TZRegistration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Names are opaque user text: trim surrounding whitespace only.
  function normalizeAttendeeName(value) {
    return String(value == null ? '' : value).trim();
  }

  function buildRegisterForEventArgs(eventId, attendeeName, phone, seats) {
    return {
      p_event_id: String(eventId || '').trim(),
      p_visitor_name: normalizeAttendeeName(attendeeName),
      p_phone: String(phone || '').trim(),
      p_seats: seats,
      p_participant_email: null,
    };
  }

  function readRegisterForEventRow(response) {
    if (!response || response.error || !Array.isArray(response.data) || !response.data.length) return null;
    return response.data[0];
  }

  function classifyRegisterForEventRow(row) {
    if (!row || typeof row.ok !== 'boolean') return 'invalid';
    if (row.ok) return ['ticket_issued', 'ticket_exists', 'pending', 'already_registered', 'ok'].includes(row.state) ? 'success' : 'invalid';
    return ['full', 'closed', 'duplicate'].includes(row.state) ? row.state : 'error';
  }

  function attendeeNameForDisplay(payload, submittedName) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'visitor_name')) {
      return normalizeAttendeeName(payload.visitor_name);
    }
    return normalizeAttendeeName(submittedName);
  }

  function mapPublicEventFlags(rows) {
    if (!Array.isArray(rows)) return null;
    const flags = Object.create(null);
    rows.forEach((row) => {
      if (!row || row.event_id == null) return;
      flags[String(row.event_id)] = {
        ...row,
        capacity_enabled: row.capacity_enabled === true,
        is_full: row.is_full === true,
        tickets_enabled: row.tickets_enabled === true,
        qr_checkin_enabled: row.qr_checkin_enabled === true,
        registration_open: row.registration_open !== false,
        show_ticket_to_attendee: row.show_ticket_to_attendee !== false,
      };
    });
    return flags;
  }

  async function fetchPublicEventFlags(rpc) {
    if (typeof rpc !== 'function') return null;
    for (const name of ['get_published_events_ticket_flags', 'get_published_events_public_flags']) {
      try {
        const response = await rpc(name);
        if (!response?.error && Array.isArray(response?.data)) return mapPublicEventFlags(response.data);
      } catch (_) { /* try the previous compatible public-flags RPC */ }
    }
    return null;
  }

  return Object.freeze({
    normalizeAttendeeName,
    buildRegisterForEventArgs,
    readRegisterForEventRow,
    classifyRegisterForEventRow,
    attendeeNameForDisplay,
    mapPublicEventFlags,
    fetchPublicEventFlags,
  });
});
