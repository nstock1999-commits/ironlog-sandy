"use strict";

/**
 * IRONLOG cloud backup endpoint.
 *
 * Standard Netlify Functions API (exports.handler / event.httpMethod) — NOT the
 * Deno-style Edge Functions API. Backed by Netlify Blobs, one key per person.
 *
 *   GET  /api/sync?person=nick   -> latest backup record (or {} if never written)
 *   POST /api/sync?person=nick   -> stores the posted state
 *   OPTIONS                      -> CORS preflight
 *
 * CORS is wide open so Nick's app can cross-origin read Sandy's data.
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];

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
      const record = await store.get(person, { type: "json" });
      // Nothing backed up yet — return an empty object rather than a 404 so the
      // reader can render an "no data yet" state without treating it as failure.
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

    const record = {
      person: person,
      updatedAt: new Date().toISOString(),
      state: payload && payload.state ? payload.state : payload
    };

    try {
      await store.setJSON(person, record);
    } catch (err) {
      return json(500, { error: "Failed to write backup", detail: errorMessage(err) });
    }

    return json(200, { ok: true, person: person, updatedAt: record.updatedAt });
  }

  return json(405, { error: "Method not allowed" });
};
