// Mockup helper: ?theme=dark|light pins the theme for screenshots. Otherwise
// the OS preference applies, exactly as in the real apps.
(function () {
  var t = new URLSearchParams(location.search).get("theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
})();
