"use strict";

/**
 * Scheduled meal reminders.
 *
 * Netlify's scheduler runs on a fixed UTC cron, but reminders are set in local
 * wall-clock time. So this runs every 15 minutes and asks, per person: what
 * time is it where they are, and is a reminder due that hasn't gone out today?
 *
 * Requires two environment variables on the site:
 *   VAPID_PUBLIC_KEY   (must match PUSH_PUBLIC_KEY in index.html)
 *   VAPID_PRIVATE_KEY
 * Optional: VAPID_SUBJECT (defaults to a mailto:). Without the keys this
 * no-ops loudly in the logs rather than throwing on every scheduled run.
 */

const { getStore } = require("@netlify/blobs");
const webpush = require("web-push");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];

// How late a missed reminder may still be delivered. Past this the slot is
// marked done without sending, so a scheduler outage at 6am doesn't fire
// breakfast, lunch and dinner all at once in the afternoon.
const GRACE_MINUTES = 120;

const MESSAGES = [
  { title: "Breakfast", body: "First meal. Get your protein in." },
  { title: "Lunch",     body: "Midday meal — stay on track." },
  { title: "Dinner",    body: "Last big meal. Hit your numbers." }
];

function slotMessage(index, time) {
  const m = MESSAGES[index] || { title: "Meal reminder", body: "Time to eat." };
  return { title: "IRONLOG — " + m.title, body: m.body, tag: "meal-" + index, url: "/" };
}

// Wall-clock date and minutes-since-midnight in an IANA timezone.
function localNow(timezone) {
  const now = new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(now);
  } catch (err) {
    return null;
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return {
    date: get("year") + "-" + get("month") + "-" + get("day"),
    minutes: hour * 60 + minute
  };
}

function toMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Which slots should fire now, and which are simply too late to bother with.
function dueSlots(record, now) {
  const due = [];
  const skip = [];
  const times = record.times || [];
  const lastSent = record.lastSent || {};

  for (let i = 0; i < times.length; i++) {
    if (lastSent[i] === now.date) continue;         // already handled today
    const slot = toMinutes(times[i]);
    if (slot === null) continue;
    const delta = now.minutes - slot;
    if (delta < 0) continue;                        // not yet
    if (delta <= GRACE_MINUTES) due.push(i);
    else skip.push(i);                              // missed the window
  }
  return { due, skip };
}

function configured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

exports.handler = async function () {
  if (!configured()) {
    console.log("[reminders] VAPID keys not set — skipping. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
    return { statusCode: 200, body: "not configured" };
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:nstock1999@gmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    console.log("[reminders] blob store unavailable:", err && err.message);
    return { statusCode: 500, body: "store unavailable" };
  }

  const summary = [];

  for (const person of PEOPLE) {
    const key = "push/" + person;
    let record;
    try {
      record = await store.get(key, { type: "json" });
    } catch (err) {
      continue;
    }
    if (!record || !record.enabled || !record.subscription) continue;

    const now = localNow(record.timezone || "UTC");
    if (!now) continue;

    const { due, skip } = dueSlots(record, now);
    if (due.length === 0 && skip.length === 0) continue;

    const lastSent = Object.assign({}, record.lastSent || {});
    let gone = false;

    for (const i of due) {
      try {
        await webpush.sendNotification(
          record.subscription,
          JSON.stringify(slotMessage(i, record.times[i]))
        );
        lastSent[i] = now.date;
        summary.push(person + ":" + record.times[i] + " sent");
      } catch (err) {
        const status = err && err.statusCode;
        // 404/410 mean the browser threw the subscription away. Keeping it
        // would just fail forever, so drop it and stop trying.
        if (status === 404 || status === 410) {
          gone = true;
          summary.push(person + ": subscription expired, cleared");
          break;
        }
        summary.push(person + ":" + record.times[i] + " failed (" + status + ")");
      }
    }

    for (const i of skip) {
      lastSent[i] = now.date;
      summary.push(person + ":" + record.times[i] + " skipped (missed window)");
    }

    try {
      const next = gone
        ? Object.assign({}, record, { enabled: false, subscription: null, lastSent: lastSent })
        : Object.assign({}, record, { lastSent: lastSent });
      await store.setJSON(key, next);
    } catch (err) {
      console.log("[reminders] failed to persist send log for", person, err && err.message);
    }
  }

  console.log("[reminders]", summary.length ? summary.join("; ") : "nothing due");
  return { statusCode: 200, body: JSON.stringify({ ok: true, actions: summary }) };
};

// Exported for tests — the scheduling decision is the part worth proving.
exports._internal = { localNow, toMinutes, dueSlots, slotMessage, GRACE_MINUTES };
