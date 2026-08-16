"use strict";

/**
 * Scheduled reminders: meals (3x daily) and body composition scans.
 *
 * Netlify's scheduler runs on a fixed UTC cron, but reminders are set in local
 * wall-clock time. So this runs every 15 minutes and asks, per person: what
 * time is it where they are, and is anything due that hasn't gone out today?
 *
 * Requires on the site:
 *   VAPID_PUBLIC_KEY   (must match PUSH_PUBLIC_KEY in index.html)
 *   VAPID_PRIVATE_KEY
 * Optional VAPID_SUBJECT. Without the keys this no-ops loudly in the logs
 * rather than throwing on every scheduled run.
 */

const { getStore } = require("@netlify/blobs");
const webpush = require("web-push");

const STORE_NAME = "ironlog";
const PEOPLE = ["nick", "sandy"];

// How late a missed reminder may still land. Past this the slot is marked done
// without sending, so an outage at 6am doesn't fire breakfast, lunch and dinner
// together in the afternoon.
const GRACE_MINUTES = 120;

// A scan reminder is worth delivering late in the day it's due, but not days
// later — by then the date has moved on.
const SCAN_GRACE_MINUTES = 720;

const MEAL_MESSAGES = [
  { title: "Breakfast", body: "First meal. Get your protein in." },
  { title: "Lunch",     body: "Midday meal — stay on track." },
  { title: "Dinner",    body: "Last big meal. Hit your numbers." }
];

function mealMessage(index) {
  const m = MEAL_MESSAGES[index] || { title: "Meal reminder", body: "Time to eat." };
  return { title: "IRONLOG — " + m.title, body: m.body, tag: "meal-" + index, url: "/" };
}

function scanMessage() {
  return {
    title: "IRONLOG — InBody Scan",
    body: "Body comp scan today. Go fasted, before training, same as last time.",
    tag: "scan",
    url: "/"
  };
}

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

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dueMealSlots(meals, now) {
  const due = [];
  const skip = [];
  const times = (meals && meals.times) || [];
  const lastSent = (meals && meals.lastSent) || {};

  for (let i = 0; i < times.length; i++) {
    if (lastSent[i] === now.date) continue;
    const slot = toMinutes(times[i]);
    if (slot === null) continue;
    const delta = now.minutes - slot;
    if (delta < 0) continue;
    if (delta <= GRACE_MINUTES) due.push(i);
    else skip.push(i);
  }
  return { due, skip };
}

// A scan is due once the calendar has reached nextDate and the local clock has
// passed the chosen time. Whether it fires or is skipped, nextDate always rolls
// forward past today so a missed cycle can't queue up behind the next one.
function scanDecision(scan, now) {
  if (!scan || !scan.enabled || !scan.nextDate) return { fire: false, advance: false };
  if (scan.lastSent === now.date) return { fire: false, advance: false };
  if (now.date < scan.nextDate) return { fire: false, advance: false };

  const at = toMinutes(scan.time) === null ? 450 : toMinutes(scan.time);
  const overdue = now.date > scan.nextDate;
  const delta = now.minutes - at;

  if (!overdue && delta < 0) return { fire: false, advance: false };   // later today
  const withinWindow = overdue || delta <= SCAN_GRACE_MINUTES;
  return { fire: withinWindow, advance: true };
}

function nextScanDate(scan, todayStr) {
  const interval = Math.max(7, Number(scan.intervalDays) || 35);
  let next = scan.nextDate;
  let guard = 0;
  while (next <= todayStr && guard++ < 500) next = addDays(next, interval);
  return next;
}

function configured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function migrate(record) {
  if (!record) return null;
  if (!record.meals && Array.isArray(record.times)) {
    record.meals = { enabled: !!record.enabled, times: record.times, lastSent: record.lastSent || {} };
  }
  record.meals = record.meals || { enabled: false, times: [], lastSent: {} };
  record.scan = record.scan || { enabled: false };
  return record;
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
      record = migrate(await store.get(key, { type: "json" }));
    } catch (err) {
      continue;
    }
    if (!record || !record.subscription) continue;

    const now = localNow(record.timezone || "UTC");
    if (!now) continue;

    let dirty = false;
    let gone = false;

    const send = async (payload, label) => {
      try {
        await webpush.sendNotification(record.subscription, JSON.stringify(payload));
        summary.push(person + ":" + label + " sent");
        return true;
      } catch (err) {
        const status = err && err.statusCode;
        if (status === 404 || status === 410) {
          gone = true;
          summary.push(person + ": subscription expired, cleared");
        } else {
          summary.push(person + ":" + label + " failed (" + status + ")");
        }
        return false;
      }
    };

    if (record.meals.enabled) {
      const { due, skip } = dueMealSlots(record.meals, now);
      const lastSent = Object.assign({}, record.meals.lastSent || {});
      for (const i of due) {
        if (gone) break;
        if (await send(mealMessage(i), record.meals.times[i])) lastSent[i] = now.date;
      }
      for (const i of skip) {
        lastSent[i] = now.date;
        summary.push(person + ":" + record.meals.times[i] + " skipped (missed window)");
      }
      if (due.length || skip.length) {
        record.meals.lastSent = lastSent;
        dirty = true;
      }
    }

    if (!gone && record.scan && record.scan.enabled) {
      const decision = scanDecision(record.scan, now);
      if (decision.advance) {
        if (decision.fire) {
          if (await send(scanMessage(), "scan " + record.scan.nextDate)) {
            record.scan.lastSent = now.date;
          }
        } else {
          summary.push(person + ":scan skipped (missed window)");
        }
        record.scan.nextDate = nextScanDate(record.scan, now.date);
        summary.push(person + ":next scan " + record.scan.nextDate);
        dirty = true;
      }
    }

    if (gone) {
      record.subscription = null;
      record.meals.enabled = false;
      if (record.scan) record.scan.enabled = false;
      dirty = true;
    }

    if (dirty) {
      try {
        await store.setJSON(key, record);
      } catch (err) {
        console.log("[reminders] failed to persist state for", person, err && err.message);
      }
    }
  }

  console.log("[reminders]", summary.length ? summary.join("; ") : "nothing due");
  return { statusCode: 200, body: JSON.stringify({ ok: true, actions: summary }) };
};

exports._internal = {
  localNow, toMinutes, addDays, dueMealSlots, scanDecision, nextScanDate,
  mealMessage, scanMessage, GRACE_MINUTES, SCAN_GRACE_MINUTES
};
