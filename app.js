/* Geri's Glideria — ice cream inventory
 *
 * Each row in the `containers` table is one physical container:
 *   { id, flavor, state, date_made }
 *   state is "full" or "half".
 *     - Full button:  delete the container
 *     - Half button:  full -> half (update), half -> delete
 *     - "+" button:   insert N full containers of a flavor, with a date
 *
 * Data lives in Supabase so it syncs across devices/people in real time.
 * localStorage is used only as an offline read cache for instant paint.
 */
(function () {
  "use strict";

  var CACHE_KEY = "glideriaCache";
  var cfg = window.GLIDERIA_CONFIG || {};
  var usingSupabase = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var db = usingSupabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;

  // ----- DOM -----
  var listEl = document.getElementById("inventory-list");
  var emptyEl = document.getElementById("empty-state");
  var summaryEl = document.getElementById("summary-list");
  var summaryEmptyEl = document.getElementById("summary-empty");
  var syncNote = document.getElementById("sync-note");
  var addBtn = document.getElementById("add-btn");
  var modal = document.getElementById("add-modal");
  var addForm = document.getElementById("add-form");
  var flavorInput = document.getElementById("flavor-input");
  var qtyInput = document.getElementById("qty-input");
  var dateInput = document.getElementById("date-input");
  var suggestions = document.getElementById("flavor-suggestions");
  var emptiesNumEl = document.getElementById("empties-num");
  var emptiesResetEl = document.getElementById("empties-reset");

  var emptiesCount = 0; // running tally of finished/empty containers
  var inventory = loadCache(); // in-memory mirror of the containers table (also sets emptiesCount)
  var currentView = "containers";
  var expanded = {}; // flavor -> bool, remembers open rows in the inventory view

  /* ---------- helpers ---------- */

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // "2026-02-04" -> "2/4"
  function shortDate(iso) {
    if (!iso) return "";
    var parts = String(iso).slice(0, 10).split("-");
    if (parts.length !== 3) return iso;
    return parseInt(parts[1], 10) + "/" + parseInt(parts[2], 10);
  }

  function makeId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Ice-cream tub icon. Fill vs. outline (and the ½) are controlled by CSS
  // via the parent .tub[data-state] element.
  function tubSVG() {
    return '<svg class="tub-svg" viewBox="0 0 24 26">' +
      '<path class="lid" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
      '<path class="body" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<text class="tub-frac" x="12" y="18.5" text-anchor="middle">½</text>' +
      '</svg>';
  }

  // An outline tub with a count inside — used for the inventory flavor counts.
  function countTubSVG(n) {
    return '<svg class="count-tub-svg" viewBox="0 0 24 26">' +
      '<path class="lid" d="M2.6 3.2 h18.8 a2.4 2.4 0 0 1 0 4.8 h-18.8 a2.4 2.4 0 0 1 0 -4.8 z"/>' +
      '<path class="body" d="M3.6 7.6 h16.8 l-1.9 15.1 a1.4 1.4 0 0 1 -1.4 1.2 h-10.2 a1.4 1.4 0 0 1 -1.4 -1.2 z"/>' +
      '<text class="count-num" x="12" y="18.7" text-anchor="middle">' + n + '</text>' +
      '</svg>';
  }

  function byFlavorThenDate(a, b) {
    var f = a.flavor.toLowerCase().localeCompare(b.flavor.toLowerCase());
    if (f !== 0) return f;
    return String(a.date_made).localeCompare(String(b.date_made));
  }

  function showNote(msg) {
    if (!msg) { syncNote.hidden = true; return; }
    syncNote.textContent = msg;
    syncNote.hidden = false;
  }

  /* ---------- cache ---------- */

  function loadCache() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.containers)) {
        emptiesCount = parsed.empties || 0;
        return parsed.containers;
      }
      if (Array.isArray(parsed)) return parsed; // legacy array format
      return [];
    } catch (e) {
      return [];
    }
  }

  function saveCache() {
    try {
      window.localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ containers: inventory, empties: emptiesCount })
      );
    } catch (e) { /* ignore */ }
  }

  /* ---------- data access ---------- */

  function fetchAll() {
    if (!usingSupabase) { render(); return Promise.resolve(); }
    return Promise.all([
      db.from("containers").select("id, flavor, state, date_made"),
      db.from("empties").select("*", { count: "exact", head: true })
    ])
      .then(function (res) {
        var cRes = res[0], eRes = res[1];
        if (cRes.error) throw cRes.error;
        inventory = cRes.data || [];
        // empties table may not exist yet; only update when the read succeeds
        if (!eRes.error && typeof eRes.count === "number") emptiesCount = eRes.count;
        saveCache();
        showNote("");
        render();
      })
      .catch(function (err) {
        console.error("fetch failed", err);
        showNote("Offline — showing last synced data.");
        render();
      });
  }

  // Run a Supabase mutation, then refetch. In local mode, just persist + render.
  function mutate(runRemote, applyLocal) {
    applyLocal();
    saveCache();
    render();
    if (!usingSupabase) return;
    runRemote()
      .then(function (res) {
        if (res && res.error) throw res.error;
        showNote("");
      })
      .catch(function (err) {
        console.error("save failed", err);
        showNote("Couldn't reach the server — changes may not have saved.");
      })
      .then(function () { fetchAll(); });
  }

  /* ---------- rendering ---------- */

  function render() {
    var sorted = inventory.slice().sort(byFlavorThenDate);
    renderContainers(sorted);
    renderInventory(sorted);
    emptiesNumEl.textContent = emptiesCount;
    refreshSuggestions();
  }

  function renderContainers(sorted) {
    listEl.innerHTML = "";
    emptyEl.hidden = sorted.length > 0;
    sorted.forEach(function (item) {
      listEl.appendChild(buildRow(item));
    });
  }

  function buildRow(item) {
    var li = document.createElement("li");
    li.className = "row";
    li.dataset.id = item.id;

    var tub = document.createElement("span");
    tub.className = "tub";
    tub.dataset.state = item.state;
    tub.setAttribute("aria-hidden", "true");
    tub.innerHTML = tubSVG();

    var name = document.createElement("span");
    name.className = "row-flavor";
    name.textContent = item.flavor;
    var date = document.createElement("span");
    date.className = "row-date";
    date.textContent = shortDate(item.date_made);
    name.appendChild(date);

    var actions = document.createElement("span");
    actions.className = "row-actions";

    // A full container can be eaten whole (Full) or halved (Half).
    // A half container only has the remaining half left, so only Half shows.
    if (item.state === "full") {
      var fullBtn = document.createElement("button");
      fullBtn.type = "button";
      fullBtn.className = "btn btn-full";
      fullBtn.textContent = "Full";
      fullBtn.setAttribute("aria-label", "Ate a full container of " + item.flavor);
      fullBtn.addEventListener("click", function () { eatFull(item.id); });
      actions.appendChild(fullBtn);
    }

    var halfBtn = document.createElement("button");
    halfBtn.type = "button";
    halfBtn.className = "btn btn-half";
    halfBtn.textContent = "Half";
    halfBtn.setAttribute("aria-label", "Ate half a container of " + item.flavor);
    halfBtn.addEventListener("click", function () { eatHalf(item.id); });
    actions.appendChild(halfBtn);

    li.appendChild(tub);
    li.appendChild(name);
    li.appendChild(actions);
    return li;
  }

  // Group sorted containers by flavor for the counts view.
  function groupByFlavor(sorted) {
    var groups = [];
    var index = {};
    sorted.forEach(function (item) {
      var key = item.flavor.toLowerCase();
      if (!(key in index)) {
        index[key] = groups.length;
        groups.push({ flavor: item.flavor, items: [] });
      }
      groups[index[key]].items.push(item);
    });
    return groups;
  }

  function renderInventory(sorted) {
    var groups = groupByFlavor(sorted);
    summaryEl.innerHTML = "";
    summaryEmptyEl.hidden = groups.length > 0;

    groups.forEach(function (g) {
      var li = document.createElement("li");
      li.className = "summary-item";
      if (expanded[g.flavor.toLowerCase()]) li.classList.add("open");

      var head = document.createElement("button");
      head.type = "button";
      head.className = "summary-head";
      head.setAttribute("aria-expanded", expanded[g.flavor.toLowerCase()] ? "true" : "false");
      head.setAttribute("aria-label", g.items.length + " " + g.flavor);

      var count = document.createElement("span");
      count.className = "summary-count";
      count.setAttribute("aria-hidden", "true");
      count.innerHTML = countTubSVG(g.items.length);

      var flavor = document.createElement("span");
      flavor.className = "summary-flavor";
      flavor.textContent = g.flavor;

      var caret = document.createElement("span");
      caret.className = "summary-caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "›"; // ›

      head.appendChild(count);
      head.appendChild(flavor);
      head.appendChild(caret);
      head.addEventListener("click", function () {
        var key = g.flavor.toLowerCase();
        expanded[key] = !expanded[key];
        li.classList.toggle("open", expanded[key]);
        head.setAttribute("aria-expanded", expanded[key] ? "true" : "false");
      });

      var dates = document.createElement("ul");
      dates.className = "summary-dates";
      g.items.forEach(function (item) {
        var d = document.createElement("li");
        var badge = document.createElement("span");
        badge.className = "date-badge";
        badge.textContent = shortDate(item.date_made);
        var lbl = document.createElement("span");
        lbl.textContent = g.flavor;
        var st = document.createElement("span");
        st.className = "date-state";
        st.textContent = item.state === "half" ? "½ tub" : "full";
        d.appendChild(badge);
        d.appendChild(lbl);
        d.appendChild(st);
        dates.appendChild(d);
      });

      li.appendChild(head);
      li.appendChild(dates);
      summaryEl.appendChild(li);
    });
  }

  function refreshSuggestions() {
    var seen = {};
    var names = [];
    inventory.forEach(function (item) {
      var key = item.flavor.toLowerCase();
      if (!seen[key]) { seen[key] = true; names.push(item.flavor); }
    });
    names.sort(function (a, b) { return a.localeCompare(b); });
    suggestions.innerHTML = "";
    names.forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = n;
      suggestions.appendChild(opt);
    });
  }

  /* ---------- actions ---------- */

  function findById(id) {
    for (var i = 0; i < inventory.length; i++) {
      if (inventory[i].id === id) return inventory[i];
    }
    return null;
  }

  function removeLocal(id) {
    inventory = inventory.filter(function (it) { return it.id !== id; });
  }

  // A container is "finished" when it's fully eaten: remove it and add one
  // to the empty-container tally.
  function finishContainer(id) {
    animateRemoval(id, function () {
      mutate(
        function () {
          return Promise.all([
            db.from("containers").delete().eq("id", id),
            db.from("empties").insert({})
          ]).then(function (results) {
            var bad = results.filter(function (r) { return r && r.error; })[0];
            return { error: bad ? bad.error : null };
          });
        },
        function () { removeLocal(id); emptiesCount++; }
      );
    });
  }

  function eatFull(id) {
    if (!findById(id)) return;
    finishContainer(id);
  }

  function eatHalf(id) {
    var item = findById(id);
    if (!item) return;
    if (item.state === "full") {
      mutate(
        function () { return db.from("containers").update({ state: "half" }).eq("id", id); },
        function () { item.state = "half"; }
      );
    } else {
      finishContainer(id);
    }
  }

  function resetEmpties() {
    mutate(
      function () { return db.from("empties").delete().not("id", "is", null); },
      function () { emptiesCount = 0; }
    );
  }

  // Delete up to `n` rows from the empties table (used when new tubs are made
  // to draw down the empty-container tally).
  function decrementEmptiesRemote(n) {
    if (n <= 0) return Promise.resolve({ error: null });
    return db.from("empties").select("id").limit(n).then(function (res) {
      if (res.error) return { error: res.error };
      var ids = (res.data || []).map(function (r) { return r.id; });
      if (ids.length === 0) return { error: null };
      return db.from("empties").delete().in("id", ids);
    });
  }

  function addContainers(flavor, qty, dateISO) {
    var rows = [];
    for (var i = 0; i < qty; i++) {
      rows.push({ flavor: flavor, state: "full", date_made: dateISO });
    }
    // Making new tubs uses up empty containers: draw the tally down by the
    // number added, but never below zero.
    var dec = Math.min(qty, emptiesCount);
    mutate(
      function () {
        return Promise.all([
          db.from("containers").insert(rows),
          decrementEmptiesRemote(dec)
        ]).then(function (results) {
          var bad = results.filter(function (r) { return r && r.error; })[0];
          return { error: bad ? bad.error : null };
        });
      },
      function () {
        rows.forEach(function (r) {
          inventory.push({ id: makeId(), flavor: r.flavor, state: r.state, date_made: r.date_made });
        });
        emptiesCount = Math.max(0, emptiesCount - dec);
      }
    );
  }

  // Animate a container row out, then run the mutation.
  function animateRemoval(id, done) {
    var row = listEl.querySelector('.row[data-id="' + id + '"]');
    if (!row || currentView !== "containers") { done(); return; }
    row.classList.add("removing");
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      done();
    };
    row.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 250);
  }

  /* ---------- view switching ---------- */

  function switchView(view) {
    currentView = view;
    document.getElementById("view-containers").hidden = view !== "containers";
    document.getElementById("view-inventory").hidden = view !== "inventory";
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
      var active = t.dataset.view === view;
      t.classList.toggle("is-active", active);
      if (active) { t.setAttribute("aria-current", "page"); }
      else { t.removeAttribute("aria-current"); }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { switchView(t.dataset.view); });
  });

  emptiesResetEl.addEventListener("click", function () {
    if (emptiesCount === 0) return;
    if (window.confirm("Reset the empty-container count to zero?")) resetEmpties();
  });

  /* ---------- add modal ---------- */

  function openModal() {
    modal.hidden = false;
    flavorInput.value = "";
    qtyInput.value = "1";
    dateInput.value = todayISO();
    flavorInput.focus();
  }
  function closeModal() { modal.hidden = true; }

  addBtn.addEventListener("click", openModal);
  modal.addEventListener("click", function (e) {
    if (e.target.hasAttribute("data-close")) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var flavor = flavorInput.value.trim();
    var qty = Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1));
    var dateISO = dateInput.value || todayISO();
    if (!flavor) return;
    addContainers(flavor, qty, dateISO);
    closeModal();
  });

  /* ---------- realtime + boot ---------- */

  if (usingSupabase) {
    db.channel("glideria-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "containers" }, function () {
        fetchAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "empties" }, function () {
        fetchAll();
      })
      .subscribe();

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) fetchAll();
    });
  } else {
    showNote("Local-only mode: add your Supabase keys in config.js to sync across devices.");
  }

  render();     // instant paint from cache
  fetchAll();   // then refresh from the server
})();
