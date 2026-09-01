/* The only JavaScript on this page: the live "dim what I'd skip" demo.
   It mirrors the extension's own rule — dim below the bar, and never dim a
   title that has no rating, because an absent rating is not a low score. */

(function () {
  "use strict";

  var grid = document.getElementById("dim-grid");
  var toggle = document.getElementById("dim-toggle");
  var slider = document.getElementById("dim-threshold");
  var value = document.getElementById("dim-value");
  var count = document.getElementById("dim-count");
  var total = document.getElementById("dim-total");

  if (!grid || !toggle || !slider) return;

  var tiles = Array.prototype.map.call(
    grid.querySelectorAll(".tile"),
    function (el) {
      var raw = el.getAttribute("data-rating");
      var num = raw === null || raw === "" ? null : parseFloat(raw);
      return { el: el, rating: isNaN(num) ? null : num };
    }
  );

  var rated = tiles.filter(function (t) { return t.rating !== null; });
  if (total) total.textContent = String(rated.length);

  function apply() {
    var bar = parseFloat(slider.value);
    var on = toggle.checked;
    var above = 0;

    tiles.forEach(function (t) {
      var below = t.rating !== null && t.rating < bar;
      if (!below && t.rating !== null) above++;
      t.el.classList.toggle("is-dimmed", on && below);
    });

    grid.setAttribute("data-dim", on ? "on" : "off");
    if (value) value.textContent = bar.toFixed(1);
    if (count) count.textContent = String(above);
  }

  slider.addEventListener("input", apply);
  toggle.addEventListener("change", apply);
  apply();
})();
