"use strict";

/**
 * Reminder settings + Web Push subscription storage.
 *
 * Standard Netlify Functions API (exports.handler / event.httpMethod).
 *
 *   GET  /api/push?person=nick  -> settings (never returns the raw
 *                                  subscription; only whether one exists)
 *   POST /api/push?person=nick  -> save { subscription, timezone, meals, scan }
 *   OPTIONS                     -> CORS preflight
 *
 * Two independent reminder kinds share one subscription:
 *   meals — three fixed times a day (Sandy only)
 *   scan  — body composition scan, every N days from a chosen date (both)
 *
 * `meals` and `scan` are each optional in a POST; whichever is absent keeps its
 * stored value, so one app can manage a kind the other never touches.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];
const MEAL_SLOTS = 3;

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

// "8:05" -> "08:05". Anything out of range is rejected rather than coerced, so
// a malformed time cannot silently mean "never fires".
function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

function normalizeDate(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  // Reject a real-looking but nonexistent date such as 2026-02-30.
  return d.toISOString().slice(0, 10) === s ? s : null;
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

const DEFAULT_MEALS = { enabled: false, times: [], lastSent: {} };
const DEFAULT_SCAN = { enabled: false, nextDate: null, intervalDays: 35, time: "07:30", lastSent: null };

// Earlier builds stored meal settings flat on the record. Fold those into the
// current shape so an existing subscription is not silently dropped.
function migrate(record) {
  if (!record) return null;
  if (!record.meals && Array.isArray(record.times)) {
    record.meals = {
      enabled: !!record.enabled,
      times: record.times,
      lastSent: record.lastSent || {}
    };
    delete record.times;
    delete record.lastSent;
    delete record.enabled;
  }
  record.meals = Object.assign({}, DEFAULT_MEALS, record.meals || {});
  record.scan = Object.assign({}, DEFAULT_SCAN, record.scan || {});
  return record;
}

function publicView(record) {
  if (!record) {
    return {
      hasSubscription: false, timezone: null,
      meals: Object.assign({}, DEFAULT_MEALS),
      scan: Object.assign({}, DEFAULT_SCAN)
    };
  }
  return {
    hasSubscription: !!record.subscription,
    timezone: record.timezone || null,
    updatedAt: record.updatedAt || null,
    meals: { enabled: !!record.meals.enabled, times: record.meals.times || [] },
    scan: {
      enabled: !!record.scan.enabled,
      nextDate: record.scan.nextDate || null,
      intervalDays: record.scan.intervalDays || DEFAULT_SCAN.intervalDays,
      time: record.scan.time || DEFAULT_SCAN.time
    }
  };
}

function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" && sub.keys &&
            typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
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

  let existing = null;
  try {
    existing = migrate(await store.get(pushKey(person), { type: "json" }));
  } catch (err) { /* treat an unreadable record as absent */ }

  if (method === "GET") {
    return json(200, publicView(existing));
  }

  if (method === "POST") {
    let payload;
    try {
      payload = JSON.parse(readBody(event) || "{}");
    } catch (err) {
      return json(400, { error: "Invalid JSON body" });
    }

    const record = existing || {
      person: person, subscription: null, timezone: "UTC",
      meals: Object.assign({}, DEFAULT_MEALS),
      scan: Object.assign({}, DEFAULT_SCAN)
    };

    if (payload.subscription) {
      if (!validSubscription(payload.subscription)) {
        return json(400, { error: "Malformed push subscription." });
      }
      record.subscription = payload.subscription;
    }
    if (validTimezone(payload.timezone)) record.timezone = payload.timezone;

    if (payload.meals) {
      const wantOn = payload.meals.enabled !== false;
      if (!wantOn) {
        record.meals = Object.assign({}, record.meals, { enabled: false });
      } else {
        const raw = Array.isArray(payload.meals.times) ? payload.meals.times : [];
        const times = raw.map(normalizeTime).filter(Boolean);
        if (times.length !== MEAL_SLOTS) {
          return json(400, { error: "Exactly " + MEAL_SLOTS + " meal times are required, as HH:MM.", received: raw });
        }
        // A changed schedule clears the send log, so a moved time can still
        // fire today rather than counting as already sent.
        const same = JSON.stringify(record.meals.times || []) === JSON.stringify(times);
        record.meals = { enabled: true, times: times, lastSent: same ? (record.meals.lastSent || {}) : {} };
      }
    }

    if (payload.scan) {
      const wantOn = payload.scan.enabled !== false;
      if (!wantOn) {
        record.scan = Object.assign({}, record.scan, { enabled: false });
      } else {
        const nextDate = normalizeDate(payload.scan.nextDate);
        if (!nextDate) return json(400, { error: "scan.nextDate must be a real YYYY-MM-DD date." });
        const time = normalizeTime(payload.scan.time) || DEFAULT_SCAN.time;
        const interval = Number(payload.scan.intervalDays);
        if (!isFinite(interval) || interval < 7 || interval > 180) {
          return json(400, { error: "scan.intervalDays must be between 7 and 180." });
        }
        const same = record.scan.nextDate === nextDate &&
                     record.scan.intervalDays === Math.round(interval) &&
                     record.scan.time === time;
        record.scan = {
          enabled: true, nextDate: nextDate, intervalDays: Math.round(interval), time: time,
          lastSent: same ? (record.scan.lastSent || null) : null
        };
      }
    }

    const anyOn = record.meals.enabled || record.scan.enabled;
    if (anyOn && !validSubscription(record.subscription)) {
      return json(400, { error: "A push subscription is required to enable reminders." });
    }
    // Nothing enabled means no reason to keep a credential for her device.
    if (!anyOn) record.subscription = null;

    record.person = person;
    record.updatedAt = new Date().toISOString();

    try {
      await store.setJSON(pushKey(person), record);
    } catch (err) {
      return json(500, { error: "Failed to save reminder settings" });
    }

    return json(200, publicView(record));
  }

  return json(405, { error: "Method not allowed" });
};

exports._internal = { normalizeTime, normalizeDate, validTimezone, publicView, migrate };
