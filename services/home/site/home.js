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

  // Number keys open the four doors. Ignored while typing or with modifiers.
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var door = document.querySelector('.door[data-key="' + e.key + '"]');
    if (door) {
      e.preventDefault();
      location.assign(door.href);
    }
  });
})();
