/* IRONLOG service worker — meal reminder notifications.
 *
 * Deliberately does NOT cache app assets. A stale cached index.html would be
 * worse than a slow load, and the app is a single small file already.
 */
"use strict";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : "" };
  }

  var title = data.title || "IRONLOG";
  var options = {
    body: data.body || "Time to eat.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "meal-reminder",
    renotify: true,
    data: { url: data.url || "/" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
