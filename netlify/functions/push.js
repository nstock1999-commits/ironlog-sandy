"use strict";

/**
 * Meal reminder settings + Web Push subscription storage.
 *
 * Standard Netlify Functions API (exports.handler / event.httpMethod).
 *
 *   GET  /api/push?person=sandy  -> current settings (never returns the raw
 *                                   subscription; only whether one exists)
 *   POST /api/push?person=sandy  -> save { subscription, times, timezone, enabled }
 *   OPTIONS                      -> CORS preflight
 *
 * The subscription itself is a bearer credential for pushing to her device, so
 * it is stored but never handed back out.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];
const SLOTS = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = Object.assign({
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
}, CORS_HEADERS);

function json(statusCode, body) {
  return { statusCode: statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function readBody(event) {
  if (!event.body) return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return event.body;
}

function pushKey(person) {
  return "push/" + person;
}

// "08:00" / "8:5" -> "08:00" / "08:05". Anything else is rejected outright so a
// malformed time cannot silently disable a reminder.
function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

function validTimezone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

function publicView(record) {
  if (!record) {
    return { enabled: false, times: [], timezone: null, hasSubscription: false };
  }
  return {
    enabled: !!record.enabled,
    times: record.times || [],
    timezone: record.timezone || null,
    hasSubscription: !!record.subscription,
    updatedAt: record.updatedAt || null
  };
}

exports.handler = async function (event) {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const params = event.queryStringParameters || {};
  const person = String(params.person || "").trim().toLowerCase();

  if (PEOPLE.indexOf(person) === -1) {
    return json(400, { error: "Unknown person." });
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return json(500, { error: "Blob store unavailable" });
  }

  if (method === "GET") {
    try {
      const record = await store.get(pushKey(person), { type: "json" });
      return json(200, publicView(record));
    } catch (err) {
      return json(500, { error: "Failed to read reminder settings" });
    }
  }

  if (method === "POST") {
    let payload;
    try {
      payload = JSON.parse(readBody(event) || "{}");
    } catch (err) {
      return json(400, { error: "Invalid JSON body" });
    }

    const enabled = payload.enabled !== false;

    // Turning reminders off clears the stored subscription rather than leaving
    // a credential lying around for a device that no longer wants them.
    if (!enabled) {
      try {
        const existing = await store.get(pushKey(person), { type: "json" });
        const record = Object.assign({}, existing, {
          enabled: false, subscription: null, updatedAt: new Date().toISOString()
        });
        await store.setJSON(pushKey(person), record);
        return json(200, publicView(record));
      } catch (err) {
        return json(500, { error: "Failed to disable reminders" });
      }
    }

    const sub = payload.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.keys ||
        typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
      return json(400, { error: "A valid push subscription is required to enable reminders." });
    }

    const rawTimes = Array.isArray(payload.times) ? payload.times : [];
    const times = rawTimes.map(normalizeTime).filter(Boolean);
    if (times.length !== SLOTS) {
      return json(400, {
        error: "Exactly " + SLOTS + " reminder times are required, as HH:MM.",
        received: rawTimes
      });
    }

    const timezone = validTimezone(payload.timezone) ? payload.timezone : "UTC";

    // Reset the per-slot send log whenever the schedule changes, so a moved
    // time can still fire today instead of being treated as already sent.
    let previous = null;
    try {
      previous = await store.get(pushKey(person), { type: "json" });
    } catch (err) { /* treat as first write */ }

    const sameSchedule = previous &&
      JSON.stringify(previous.times || []) === JSON.stringify(times) &&
      previous.timezone === timezone;

    const record = {
      person: person,
      enabled: true,
      subscription: sub,
      times: times,
      timezone: timezone,
      lastSent: sameSchedule && previous.lastSent ? previous.lastSent : {},
      updatedAt: new Date().toISOString()
    };

    try {
      await store.setJSON(pushKey(person), record);
    } catch (err) {
      return json(500, { error: "Failed to save reminder settings" });
    }

    return json(200, publicView(record));
  }

  return json(405, { error: "Method not allowed" });
};

// Exported for tests.
exports._internal = { normalizeTime, validTimezone, publicView };
