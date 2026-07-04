/* Ice Cream Inventory — single-screen tracker
 * Each item is one physical container: { id, flavor, state }
 * state is "full" or "half".
 *   - Half button:  full -> half, half -> removed
 *   - Full button:  removed regardless of state
 *   - "+" button:   adds a new full container
 * State persists on-device via localStorage.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "iceCreamInventory";

  // Flavors from the original sketch, seeded only on first run.
  var SEED = [
    { flavor: "Lychee", state: "full" },
    { flavor: "Vanilla", state: "full" },
    { flavor: "Chocolate", state: "full" },
    { flavor: "Grapefruit", state: "half" },
    { flavor: "Froyo", state: "half" },
    { flavor: "Froyo", state: "half" },
    { flavor: "Froyo", state: "full" },
    { flavor: "Vanilla", state: "full" },
    { flavor: "Vanilla", state: "half" }
  ];

  var listEl = document.getElementById("inventory-list");
  var emptyEl = document.getElementById("empty-state");
  var addBtn = document.getElementById("add-btn");
  var modal = document.getElementById("add-modal");
  var addForm = document.getElementById("add-form");
  var flavorInput = document.getElementById("flavor-input");
  var suggestions = document.getElementById("flavor-suggestions");

  var inventory = load();

  /* ---------- persistence ---------- */

  function load() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      raw = null; // storage may be blocked (e.g. private mode)
    }
    if (raw === null) {
      var seeded = SEED.map(function (s) {
        return { id: makeId(), flavor: s.flavor, state: s.state };
      });
      save(seeded);
      return seeded;
    }
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function save(data) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* ignore write failures; in-memory state still works this session */
    }
  }

  function makeId() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- rendering ---------- */

  function render() {
    listEl.innerHTML = "";
    emptyEl.hidden = inventory.length > 0;

    inventory.forEach(function (item) {
      listEl.appendChild(buildRow(item));
    });

    refreshSuggestions();
  }

  function buildRow(item) {
    var li = document.createElement("li");
    li.className = "row";
    li.dataset.id = item.id;

    // container icon
    var tub = document.createElement("span");
    tub.className = "tub";
    tub.dataset.state = item.state;
    tub.setAttribute("aria-hidden", "true");
    var fill = document.createElement("span");
    fill.className = "fill";
    tub.appendChild(fill);
    if (item.state === "half") {
      var label = document.createElement("span");
      label.className = "label";
      label.textContent = "½"; // ½
      tub.appendChild(label);
    }

    // flavor name
    var name = document.createElement("span");
    name.className = "row-flavor";
    name.textContent = item.flavor;
    name.title = item.flavor + " — " + item.state + " container";

    // actions
    var actions = document.createElement("span");
    actions.className = "row-actions";

    var fullBtn = document.createElement("button");
    fullBtn.type = "button";
    fullBtn.className = "btn btn-full";
    fullBtn.textContent = "Full";
    fullBtn.setAttribute("aria-label", "Ate a full container of " + item.flavor);
    fullBtn.addEventListener("click", function () { eatFull(item.id); });

    var halfBtn = document.createElement("button");
    halfBtn.type = "button";
    halfBtn.className = "btn btn-half";
    halfBtn.textContent = "Half";
    halfBtn.setAttribute("aria-label", "Ate half a container of " + item.flavor);
    halfBtn.addEventListener("click", function () { eatHalf(item.id); });

    actions.appendChild(fullBtn);
    actions.appendChild(halfBtn);

    li.appendChild(tub);
    li.appendChild(name);
    li.appendChild(actions);
    return li;
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

  function findIndex(id) {
    for (var i = 0; i < inventory.length; i++) {
      if (inventory[i].id === id) return i;
    }
    return -1;
  }

  function eatFull(id) {
    var i = findIndex(id);
    if (i === -1) return;
    removeRow(id, function () {
      inventory.splice(i, 1);
      commit();
    });
  }

  function eatHalf(id) {
    var i = findIndex(id);
    if (i === -1) return;
    if (inventory[i].state === "full") {
      inventory[i].state = "half";
      commit();
    } else {
      removeRow(id, function () {
        inventory.splice(i, 1);
        commit();
      });
    }
  }

  function addFlavor(flavor) {
    inventory.push({ id: makeId(), flavor: flavor, state: "full" });
    commit();
  }

  // Persist + re-render.
  function commit() {
    save(inventory);
    render();
  }

  // Animate a row out, then run the mutation.
  function removeRow(id, done) {
    var row = listEl.querySelector('.row[data-id="' + id + '"]');
    if (!row) { done(); return; }
    row.classList.add("removing");
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      done();
    };
    row.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 250); // fallback if transitionend doesn't fire
  }

  /* ---------- add-flavor modal ---------- */

  function openModal() {
    modal.hidden = false;
    flavorInput.value = "";
    flavorInput.focus();
  }

  function closeModal() {
    modal.hidden = true;
  }

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
    if (!flavor) return;
    addFlavor(flavor);
    closeModal();
  });

  /* ---------- boot ---------- */

  render();
})();
