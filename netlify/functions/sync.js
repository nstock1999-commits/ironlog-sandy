"use strict";

/**
 * IRONLOG cloud backup endpoint.
 *
 * Standard Netlify Functions API (exports.handler / event.httpMethod) — NOT the
 * Deno-style Edge Functions API. Backed by Netlify Blobs.
 *
 *   GET  /api/sync?person=nick              -> latest backup (or {} if none)
 *   GET  /api/sync?person=nick&list=1       -> dated snapshots available
 *   GET  /api/sync?person=nick&date=2026-08-16 -> one dated snapshot
 *   POST /api/sync?person=nick              -> store, and stamp today's snapshot
 *   OPTIONS                                 -> CORS preflight
 *
 * Two things protect the log from being destroyed by a bad write:
 *   1. A payload with no real work is refused when a payload WITH work is
 *      already stored. A browser that has lost its localStorage would
 *      otherwise overwrite a good backup with an empty one on first save.
 *   2. Every write also stamps a dated snapshot, so yesterday survives even
 *      if today's record is wrong. Snapshots older than RETAIN_DAYS are pruned.
 *
 * CORS is wide open so Nick's app can cross-origin read Sandy's data.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];
const RETAIN_DAYS = 90;

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

function errorMessage(err) {
  return String((err && err.message) || err || "unknown error");
}

function readBody(event) {
  if (!event.body) return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return event.body;
}

function snapshotKey(person, day) {
  return person + "/" + day;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// "Real work" means something a lifter would be upset to lose: a logged set, an
// archived session, or a nutrition entry. A freshly seeded program is not work.
function countWork(state) {
  if (!state || typeof state !== "object") return 0;
  let n = 0;
  if (Array.isArray(state.exercises)) {
    for (const ex of state.exercises) {
      if (Array.isArray(ex.sets)) {
        for (const s of ex.sets) {
          if (s && typeof s.weight === "number" && typeof s.reps === "number") n++;
        }
      }
      if (Array.isArray(ex.history)) {
        // Skip imported starting weights -- they are a seeded floor, not
        // logged work, and must not make an empty log look populated.
        for (const h of ex.history) {
          if (h && !h.imported && Array.isArray(h.sets)) n += h.sets.length;
        }
      }
    }
  }
  if (state.nutrition && Array.isArray(state.nutrition.entries)) {
    n += state.nutrition.entries.length;
  }
  return n;
}

async function prune(store, person) {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
  try {
    const { blobs } = await store.list({ prefix: person + "/" });
    await Promise.all(
      blobs
        .filter((b) => b.key.slice(person.length + 1) < cutoff)
        .map((b) => store.delete(b.key).catch(() => {}))
    );
  } catch (err) {
    // Pruning is housekeeping. Never fail a backup because it did not work.
  }
}

exports.handler = async function (event) {
  const method = event.httpMethod;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const params = event.queryStringParameters || {};
  const person = String(params.person || "").trim().toLowerCase();

  if (PEOPLE.indexOf(person) === -1) {
    return json(400, { error: "Unknown person. Use ?person=nick or ?person=sandy." });
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return json(500, { error: "Blob store unavailable", detail: errorMessage(err) });
  }

  if (method === "GET") {
    try {
      if (params.list) {
        const { blobs } = await store.list({ prefix: person + "/" });
        const dates = blobs.map((b) => b.key.slice(person.length + 1)).sort().reverse();
        return json(200, { person: person, snapshots: dates });
      }
      if (params.date) {
        const day = String(params.date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return json(400, { error: "date must be YYYY-MM-DD" });
        }
        const snap = await store.get(snapshotKey(person, day), { type: "json" });
        if (!snap) return json(404, { error: "No snapshot for " + day });
        return json(200, snap);
      }
      const record = await store.get(person, { type: "json" });
      return json(200, record || {});
    } catch (err) {
      return json(500, { error: "Failed to read backup", detail: errorMessage(err) });
    }
  }

  if (method === "POST") {
    let payload;
    try {
      payload = JSON.parse(readBody(event) || "{}");
    } catch (err) {
      return json(400, { error: "Invalid JSON body" });
    }

    const incoming = payload && payload.state ? payload.state : payload;
    const incomingWork = countWork(incoming);

    // Refuse to trade a log with work in it for one without, unless the caller
    // explicitly insists. This is the guard against a wiped browser wiping the
    // backup too.
    if (incomingWork === 0 && !params.force) {
      let existingWork = 0;
      try {
        const existing = await store.get(person, { type: "json" });
        existingWork = countWork(existing && existing.state);
      } catch (err) { /* treat an unreadable existing record as empty */ }

      if (existingWork > 0) {
        return json(409, {
          error: "Refusing to overwrite a non-empty backup with an empty one.",
          storedEntries: existingWork,
          hint: "Add ?force=1 only if you really mean to erase the backup."
        });
      }
    }

    const record = {
      person: person,
      updatedAt: new Date().toISOString(),
      entries: incomingWork,
      state: incoming
    };

    try {
      await store.setJSON(person, record);
    } catch (err) {
      return json(500, { error: "Failed to write backup", detail: errorMessage(err) });
    }

    // A dated copy so a bad day is recoverable. Best-effort: the primary
    // record is already safely written by this point.
    const day = today();
    try {
      await store.setJSON(snapshotKey(person, day), record);
      await prune(store, person);
    } catch (err) { /* snapshot is a bonus, not a requirement */ }

    return json(200, {
      ok: true, person: person, updatedAt: record.updatedAt,
      entries: incomingWork, snapshot: day
    });
  }

  return json(405, { error: "Method not allowed" });
};
