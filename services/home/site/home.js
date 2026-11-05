// Home portal. Computes every app URL from the page's own hostname so the
// same static files serve any domain: home.lab.localhost -> storage.lab.localhost.
(function () {
  "use strict";

  var host = location.hostname;
  var base = host.replace(/^home\./, "");
  if (base === host) {
    // Not served as home.<domain> (for example file:// or a bare IP).
    // Fall back to the committed default so links still point somewhere real.
    base = "lab.localhost";
  }
  var port = location.port && location.port !== "443" ? ":" + location.port : "";
  var scheme = location.protocol === "http:" ? "http:" : "https:";

  function url(app) {
    return scheme + "//" + app + "." + base + port + "/";
  }
  function label(app) {
    return app + "." + base;
  }

  var domainEl = document.getElementById("domain");
  if (domainEl) domainEl.textContent = base;

  var links = document.querySelectorAll("[data-host]");
  for (var i = 0; i < links.length; i++) {
    links[i].href = url(links[i].getAttribute("data-host"));
  }

  var labels = document.querySelectorAll("[data-host-label]");
  for (var j = 0; j < labels.length; j++) {
    labels[j].textContent = label(labels[j].getAttribute("data-host-label"));
  }

  // Authelia's logout endpoint, returning here afterwards.
  var signout = document.querySelector("[data-signout]");
  if (signout) {
    signout.href = url("auth") + "logout?rd=" + encodeURIComponent(url("home"));
  }

  // Show who is signed in, and hide links that only admins can open. Authelia
  // still enforces access; this only spares friends a door that refuses them.
  fetch("/api/me", { credentials: "same-origin", redirect: "manual", cache: "no-store" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (me) {
      if (!me || !me.user) return;
      var name = me.name || me.user;
      var meEl = document.getElementById("me");
      document.getElementById("me-name").textContent = name;
      document.getElementById("me-initial").textContent = name.charAt(0).toUpperCase();
      meEl.title = me.email ? name + " (" + me.email + ")" : name;
      meEl.hidden = false;
      var groups = (me.groups || "").split(",");
      if (groups.indexOf("admins") === -1) {
        var adminOnly = document.querySelectorAll("[data-admin-only]");
        for (var k = 0; k < adminOnly.length; k++) adminOnly[k].hidden = true;
      }
    })
    .catch(function () { /* Leave every link visible; access control is Authelia's job. */ });

  // Number keys open the visible doors. Ignored while typing or with modifiers.
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var door = document.querySelector('.door[data-key="' + e.key + '"]:not([hidden])');
    if (door) {
      e.preventDefault();
      location.assign(door.href);
    }
  });
})();
