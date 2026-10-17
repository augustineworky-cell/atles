/* =====================================================================
   theme.js - picks the look BEFORE the page paints (no flash).

   Modes:  auto (default) | premium | durga | hydrangea
   - premium   = the calm daily look (navy + gold hairline)
   - durga     = Festive mode (the Durga Puja look with sparks and petals)
   - auto      = premium every day, and festive automatically on the dates below

   TO ADD / CHANGE A FESTIVAL: edit FESTIVE (dates are YYYY-MM-DD, both ends included).
   ===================================================================== */
(function () {
  'use strict';
  var KEY = 'dccThemeMode';
  var FESTIVE = [
    { id: 'durga', from: '2026-10-10', to: '2026-10-21' }   // Mahalaya to Dashami - change if needed
  ];
  var THEMES = [
    { id: 'premium', name: 'Professional' },
    { id: 'durga', name: 'Festive (Durga Puja)' },
    { id: 'hydrangea', name: 'Hydrangea' }
  ];

  function today() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
  function festiveNow() {
    var t = today();
    for (var i = 0; i < FESTIVE.length; i++) if (t >= FESTIVE[i].from && t <= FESTIVE[i].to) return FESTIVE[i].id;
    return null;
  }
  function valid(mode) {
    if (mode === 'auto') return true;
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === mode) return true;
    return false;
  }
  function resolve(mode) {
    if (mode === 'auto') return festiveNow() || 'premium';
    return valid(mode) ? mode : 'premium';
  }
  function getMode() {
    var m = 'auto';
    try { m = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* storage blocked */ }
    return valid(m) ? m : 'auto';
  }
  function setMode(mode, save) {
    if (!valid(mode)) mode = 'auto';
    document.documentElement.dataset.theme = resolve(mode);
    document.documentElement.dataset.themeMode = mode;
    if (save) { try { localStorage.setItem(KEY, mode); } catch (e) { /* storage blocked */ } }
    return mode;
  }

  window.DCC_THEME = {
    THEMES: THEMES,
    MODES: ['auto'].concat(THEMES.map(function (t) { return t.id; })),
    getMode: getMode, setMode: setMode, resolve: resolve, festiveNow: festiveNow,
    name: function (id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i].name; return id; }
  };
  setMode(getMode(), false);
})();
