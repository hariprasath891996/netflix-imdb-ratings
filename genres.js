// A picker for the numbered categories Netflix files its catalogue under but
// never puts a row in front of you. Runs after content.js and sort.js, in the
// same isolated world, and shares nothing with either beyond the page.
//
// This answers a different question from the rest of the extension. The badges
// answer "is this good"; a viewer who has scrolled past the twenty rows Netflix
// chose for them is asking "what else is there", and the honest answer is that
// there are hundreds of categories reachable only by typing a URL. Handing over
// the URLs is the whole feature — and the pages they land on are grids, so the
// badges and the rating sort are already waiting there.
//
// Content scripts injected into the same world share one global lexical scope,
// so a top-level `const` here would collide with content.js's or sort.js's and
// throw before any of the three ran. Everything below is closed over instead.
(function () {
  "use strict";

  // The manifest injects this file on Prime Video and Amazon as well, where
  // every URL below is meaningless. Netflix category IDs are Netflix's, and a
  // picker that navigated Prime to netflix.com would be a bug wearing a
  // feature's clothes.
  if (!/(^|\.)netflix\.com$/.test(location.hostname)) return;

  // --- the categories -------------------------------------------------------
  // These are community-documented IDs, not an official API. Netflix has never
  // published this list; it has been assembled and re-checked by users over
  // years of poking at /browse/genre/<id>, and Netflix can retire, merge or
  // empty any one of them at any time without telling anyone. Nothing here is
  // guaranteed to resolve, which is why the panel says so in its own footer
  // rather than presenting these as a catalogue index.
  //
  // The selection is deliberately the well-attested core rather than every
  // number ever posted in a listicle. Codes that appear inconsistently across
  // sources, or that conflict with another code, were dropped: a picker full of
  // dead links teaches you to distrust the live ones.
  //
  // Shape is [id, label] because there are nearly two hundred of them and an
  // object per row would bury the data in punctuation. Groups run broad first,
  // then narrower, which is also the order the panel renders them in.
  const CATEGORIES = [
    {
      // The shelves Netflix's own nav mostly agrees exist. They earn their
      // place at the top because they are the ones people can name, and because
      // they are the entry point to a grid rather than to a nest of rows.
      name: "Broad genres",
      items: [
        [1365, "Action & Adventure"],
        [7424, "Anime"],
        [783, "Children & Family"],
        [31574, "Classic Movies"],
        [6548, "Comedies"],
        [7627, "Cult Movies"],
        [6839, "Documentaries"],
        [5763, "Dramas"],
        [26835, "Faith & Spirituality"],
        [8711, "Horror Movies"],
        [7077, "Independent Movies"],
        [78367, "International Movies"],
        [1701, "Music & Musicals"],
        [8883, "Romantic Movies"],
        [1492, "Sci-Fi & Fantasy"],
        [4370, "Sports Movies"],
        [8933, "Thrillers"],
        [83, "TV Shows"]
      ]
    },
    {
      name: "Action & adventure",
      items: [
        [43040, "Action Comedies"],
        [1568, "Action Sci-Fi & Fantasy"],
        [43048, "Action Thrillers"],
        [7442, "Adventures"],
        [77232, "Asian Action Movies"],
        [46576, "Classic Action & Adventure"],
        [9584, "Crime Action & Adventure"],
        [11828, "Foreign Action & Adventure"],
        [8985, "Martial Arts Movies"],
        [2125, "Military Action & Adventure"],
        [10702, "Spy Action & Adventure"],
        [7700, "Westerns"]
      ]
    },
    {
      name: "Anime",
      items: [
        [2653, "Anime Action"],
        [9302, "Anime Comedies"],
        [452, "Anime Dramas"],
        [11146, "Anime Fantasy"],
        [3063, "Anime Features"],
        [10695, "Anime Horror"],
        [2729, "Anime Sci-Fi"],
        [6721, "Anime Series"]
      ]
    },
    {
      name: "Children & family",
      items: [
        [6796, "Ages 0-2"],
        [6218, "Ages 2-4"],
        [5455, "Ages 5-7"],
        [561, "Ages 8-10"],
        [6962, "Ages 11-12"],
        [5507, "Animal Tales"],
        [67673, "Disney"],
        [10659, "Education for Kids"],
        [51056, "Family Features"],
        [27346, "Kids' TV"],
        [52843, "Kids Music"],
        [10056, "Movies Based on Children's Books"],
        [11177, "TV Cartoons"]
      ]
    },
    {
      name: "Classics",
      items: [
        [31694, "Classic Comedies"],
        [29809, "Classic Dramas"],
        [47147, "Classic Sci-Fi & Fantasy"],
        [46588, "Classic Thrillers"],
        [48744, "Classic War Movies"],
        [47465, "Classic Westerns"],
        [52858, "Epics"],
        [7687, "Film Noir"],
        [53310, "Silent Films"]
      ]
    },
    {
      name: "Comedies",
      items: [
        [869, "Dark Comedies"],
        [1402, "Late Night Comedies"],
        [26, "Mockumentaries"],
        [2700, "Political Comedies"],
        [4922, "Satires"],
        [9702, "Screwball Comedies"],
        [10256, "Slapstick Comedies"],
        [5286, "Sports Comedies"],
        [11559, "Stand-up Comedy"],
        [3519, "Teen Comedies"]
      ]
    },
    {
      name: "Documentaries",
      items: [
        [3652, "Biographical Documentaries"],
        [9875, "Crime Documentaries"],
        [5161, "Foreign Documentaries"],
        [5349, "Historical Documentaries"],
        [4006, "Military Documentaries"],
        [90361, "Music & Concert Documentaries"],
        [7018, "Political Documentaries"],
        [10005, "Religious Documentaries"],
        [2595, "Science & Nature Documentaries"],
        [3675, "Social & Cultural Documentaries"],
        [180, "Sports Documentaries"],
        [1159, "Travel & Adventure Documentaries"]
      ]
    },
    {
      name: "Dramas",
      items: [
        [3179, "Biographical Dramas"],
        [2748, "Courtroom Dramas"],
        [6889, "Crime Dramas"],
        [4961, "Dramas Based on Books"],
        [3653, "Dramas Based on Real Life"],
        [2150, "Foreign Dramas"],
        [384, "Indie Dramas"],
        [11, "Military Dramas"],
        [6616, "Political Dramas"],
        [5012, "Showbiz Dramas"],
        [3947, "Social Issue Dramas"],
        [7243, "Sports Dramas"],
        [6384, "Tearjerkers"],
        [9299, "Teen Dramas"]
      ]
    },
    {
      name: "Horror",
      items: [
        [8195, "B-Horror Movies"],
        [6895, "Creature Features"],
        [10944, "Cult Horror Movies"],
        [45028, "Deep Sea Horror Movies"],
        [8654, "Foreign Horror Movies"],
        [89585, "Horror Comedy"],
        [947, "Monster Movies"],
        [6998, "Satanic Stories"],
        [8646, "Slasher and Serial Killer Movies"],
        [42023, "Supernatural Horror Movies"],
        [52147, "Teen Screams"],
        [75804, "Vampire Horror Movies"],
        [75930, "Werewolf Horror Movies"],
        [75405, "Zombie Horror Movies"]
      ]
    },
    {
      name: "Independent",
      items: [
        [11079, "Experimental Movies"],
        [11804, "Independent Action & Adventure"],
        [4195, "Independent Comedies"],
        [3269, "Independent Thrillers"]
      ]
    },
    {
      // Netflix's own catalogue is regional, so these are the categories most
      // likely to be thin or empty depending on where the account is — which is
      // the same caveat as a retired code, and handled the same way: stated in
      // the footer, not promised away here.
      name: "International",
      items: [
        [3761, "African Movies"],
        [5230, "Australian Movies"],
        [10757, "British Movies"],
        [3960, "Chinese Movies"],
        [5254, "Eastern European Movies"],
        [58807, "French Movies"],
        [58886, "German Movies"],
        [10463, "Indian Movies"],
        [8221, "Italian Movies"],
        [10398, "Japanese Movies"],
        [5685, "Korean Movies"],
        [1613, "Latin American Movies"],
        [5875, "Middle Eastern Movies"],
        [11567, "Russian Movies"],
        [9292, "Scandinavian Movies"],
        [9196, "Southeast Asian Movies"],
        [58741, "Spanish Movies"]
      ]
    },
    {
      name: "Music & musicals",
      items: [
        [32392, "Classic Musicals"],
        [1105, "Country & Western/Folk"],
        [10271, "Jazz & Easy Listening"],
        [10741, "Latin Music"],
        [13335, "Musicals"],
        [3278, "Rock & Pop Concerts"],
        [9472, "Urban & Dance Concerts"],
        [2856, "World Music Concerts"]
      ]
    },
    {
      name: "Romance",
      items: [
        [31273, "Classic Romantic Movies"],
        [5475, "Romantic Comedies"],
        [1255, "Romantic Dramas"],
        [7153, "Romantic Foreign Movies"],
        [9916, "Romantic Independent Movies"],
        [35800, "Steamy Romantic Movies"]
      ]
    },
    {
      name: "Sci-fi & fantasy",
      items: [
        [3327, "Alien Sci-Fi"],
        [4734, "Cult Sci-Fi & Fantasy"],
        [9744, "Fantasy Movies"],
        [6926, "Sci-Fi Adventure"],
        [3916, "Sci-Fi Dramas"],
        [1694, "Sci-Fi Horror Movies"],
        [11014, "Sci-Fi Thrillers"]
      ]
    },
    {
      name: "Sport",
      items: [
        [12339, "Baseball Movies"],
        [12762, "Basketball Movies"],
        [12443, "Boxing Movies"],
        [12803, "Football Movies"],
        [6695, "Martial Arts, Boxing & Wrestling"],
        [12549, "Soccer Movies"],
        [9327, "Sports & Fitness"]
      ]
    },
    {
      name: "Thrillers",
      items: [
        [10499, "Crime Thrillers"],
        [10306, "Foreign Thrillers"],
        [31851, "Gangster Movies"],
        [9994, "Mysteries"],
        [10504, "Political Thrillers"],
        [5505, "Psychological Thrillers"],
        [9147, "Spy Thrillers"],
        [11140, "Supernatural Thrillers"]
      ]
    },
    {
      name: "TV",
      items: [
        [52117, "British TV Shows"],
        [46553, "Classic TV Shows"],
        [26146, "Crime TV Shows"],
        [74652, "Cult TV Shows"],
        [72436, "Food & Travel TV"],
        [67879, "Korean TV Shows"],
        [25804, "Military TV Shows"],
        [9833, "Reality TV"],
        [52780, "Science & Nature TV"],
        [10673, "TV Action & Adventure"],
        [10375, "TV Comedies"],
        [10105, "TV Documentaries"],
        [11714, "TV Dramas"],
        [83059, "TV Horror"],
        [4366, "TV Mysteries"],
        [1372, "TV Sci-Fi & Fantasy"],
        [60951, "Teen TV Shows"]
      ]
    }
  ];

  const TOTAL = CATEGORIES.reduce((sum, group) => sum + group.items.length, 0);

  // Where the picker has no business appearing. The player is the obvious one —
  // a floating button over a film is exactly the intrusion this feature is
  // trying not to be — and the rest are pages where there is no catalogue to
  // browse yet. Bare "/" is the signed-out marketing page; every signed-in
  // surface has a path segment.
  const HIDDEN_PATHS = /^\/(watch|profiles|login|signup|password|simpleSignUp)\b/i;

  function pickerBelongsHere() {
    return location.pathname !== "/" && !HIDDEN_PATHS.test(location.pathname);
  }

  // Same reasoning as content.js's copy: the chord is invisible otherwise, and
  // a hint naming the wrong key is worse than no hint. Local to this IIFE, so
  // it shadows rather than collides.
  const MOD_LABEL =
    /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "⌘" : "Ctrl";

  // --- state ----------------------------------------------------------------
  let root = null;
  let trigger = null;
  let backdrop = null;
  let panel = null;
  let input = null;
  let listEl = null;
  let statusEl = null;

  // The options currently on screen, in the order they are rendered — which is
  // what the arrow keys walk. Rebuilt on every keystroke, so nothing here
  // outlives a render.
  let options = [];
  let activeIndex = -1;
  let isOpen = false;

  // Where focus came from. The trigger is the answer almost always, but the
  // picker can also be opened from the keyboard while focus sits on a Netflix
  // card, and dumping that user back on a button they never touched would lose
  // their place in the page.
  let opener = null;

  function url(id) {
    return `https://www.netflix.com/browse/genre/${id}`;
  }

  // --- the list -------------------------------------------------------------
  // A flat search over ~190 rows is cheap enough to redo on every keystroke, so
  // there is no index to keep in sync with the data above.
  //
  // Matching the group name as well as the row's own is what makes "horror"
  // useful: it pulls up the whole Horror group alongside the rows with the word
  // in their title. Matching a bare number is the other half — these codes get
  // copied out of articles, and someone holding "1365" wants to know what it is
  // before they open it.
  function matches(query, id, name, groupName) {
    if (!query) return true;
    if (name.toLowerCase().includes(query)) return true;
    if (groupName.toLowerCase().includes(query)) return true;
    return /^\d+$/.test(query) && String(id).startsWith(query);
  }

  function buildOption(id, name) {
    // A real anchor, not a div with a click handler: it gives middle-click and
    // ⌘-click their ordinary meaning for free, and it puts the destination in
    // the browser's status bar, which is the one place a user can check a code
    // before committing to it.
    const option = document.createElement("a");
    option.className = "nrx-genre-option";
    option.id = `nrx-genre-opt-${id}`;
    option.href = url(id);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");

    // Never a tab stop. Focus stays in the search field and the active row is
    // published through aria-activedescendant, so Tab means "leave the list",
    // not "step through two hundred of them".
    option.tabIndex = -1;

    const label = document.createElement("span");
    label.className = "nrx-genre-name";
    label.textContent = name;

    // The code is the thing you can write down and it is what the URL is made
    // of, so it is shown rather than hidden behind the link.
    const code = document.createElement("span");
    code.className = "nrx-genre-code";
    code.textContent = String(id);

    option.append(label, code);
    return option;
  }

  function render(query) {
    const needle = query.trim().toLowerCase();

    listEl.textContent = "";
    options = [];
    activeIndex = -1;

    for (const group of CATEGORIES) {
      const hits = group.items.filter(([id, name]) => matches(needle, id, name, group.name));
      if (!hits.length) continue;

      // role=group with its own label rather than a heading element: a heading
      // inside a listbox is not a thing screen readers will read as structure,
      // whereas a labelled group is exactly this — a band of options with a
      // name.
      const section = document.createElement("div");
      section.className = "nrx-genre-group";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.name);

      const heading = document.createElement("div");
      heading.className = "nrx-genre-group-name";
      heading.textContent = group.name;
      heading.setAttribute("aria-hidden", "true"); // the group above already says it
      section.appendChild(heading);

      for (const [id, name] of hits) {
        const element = buildOption(id, name);
        section.appendChild(element);
        options.push({ id, name, element });
      }

      listEl.appendChild(section);
    }

    if (!options.length) {
      statusEl.textContent = `No category matches “${query.trim()}”`;
    } else if (needle) {
      statusEl.textContent = `${options.length} of ${TOTAL} categories`;
    } else {
      statusEl.textContent = `${TOTAL} categories`;
    }

    // The first row is pre-armed so that typing three letters and pressing
    // Enter works without an intervening arrow key — which is how this control
    // is used most of the time.
    if (options.length) setActive(0, false);
    else input.removeAttribute("aria-activedescendant");
  }

  // `scroll` is false when the pointer moved the highlight: scrolling the list
  // under a moving mouse makes the highlight chase the cursor and is the one
  // way this control can feel broken.
  function setActive(index, scroll) {
    const previous = options[activeIndex];
    if (previous) {
      delete previous.element.dataset.active;
      previous.element.setAttribute("aria-selected", "false");
    }

    activeIndex = index;
    const current = options[index];
    if (!current) {
      input.removeAttribute("aria-activedescendant");
      return;
    }

    current.element.dataset.active = "true";
    current.element.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", current.element.id);
    if (scroll) current.element.scrollIntoView({ block: "nearest" });
  }

  // Wraps deliberately. The list is long and the groups at the far end are the
  // narrow ones nobody scrolls to, so ArrowUp from the top is the cheapest way
  // to reach them.
  function moveActive(delta) {
    if (!options.length) return;
    const next = (activeIndex + delta + options.length) % options.length;
    setActive(next, true);
  }

  function openCategory(entry, newTab) {
    if (!entry) return;
    if (newTab) {
      // noopener because the new tab is another Netflix page and has no reason
      // to hold a handle back to this one.
      window.open(url(entry.id), "_blank", "noopener");
      return;
    }
    close();
    location.assign(url(entry.id));
  }

  // --- open and close -------------------------------------------------------
  function open() {
    if (isOpen || !root) return;
    isOpen = true;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    backdrop.hidden = false;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");

    input.value = "";
    render("");
    input.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    backdrop.hidden = true;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");

    // Back where they came from, and back to the trigger when that no longer
    // exists — Netflix can navigate underneath an open panel, and focus landing
    // on <body> would strand a keyboard user at the top of the document.
    const target = opener && opener.isConnected ? opener : trigger;
    opener = null;
    if (target && target.isConnected) target.focus();
  }

  // Focus trap. A dialog that lets Tab wander into the page behind it is a
  // dialog a screen reader user cannot tell they are still inside — and the
  // page behind this one is a Netflix grid with a tab stop on every tile.
  // Cycling explicitly rather than relying on the focusin net below keeps Tab
  // and Shift+Tab meaning what they normally mean within the panel.
  function trapTab(event) {
    const focusable = panel.querySelectorAll("button, input, [href]:not([tabindex='-1'])");
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onPanelKeydown(event) {
    if (event.key === "Tab") {
      trapTab(event);
      return;
    }

    // Everything below is a list command, and holding a browser modifier means
    // the user was talking to the browser — except on Enter, where the chord is
    // the documented "open in a new tab".
    if (event.altKey) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        if (options.length) { event.preventDefault(); setActive(0, true); }
        break;
      case "End":
        if (options.length) { event.preventDefault(); setActive(options.length - 1, true); }
        break;
      case "Enter":
        event.preventDefault();
        openCategory(options[activeIndex], event.metaKey || event.ctrlKey);
        break;
      default:
        break;
    }
  }

  // --- the DOM --------------------------------------------------------------
  // Built once and kept. Netflix re-rendering its own tree cannot reach a
  // subtree it never owned, so the usual outcome is that this element simply
  // stays put; sync() below handles the case where it does not.
  function build() {
    const container = document.createElement("div");
    container.className = "nrx-genre-root";

    // Where the trigger goes, and why here.
    //
    // Netflix's top bar is the obvious place and the wrong one. It is a React
    // subtree that Netflix rebuilds on every navigation and reflows on scroll,
    // so anything inserted into it has to be re-inserted constantly and gets a
    // vote on Netflix's own layout — the two things the brief rules out. The
    // page flow is no better: the browse page has no stable header block that
    // exists on every surface, and pushing one in would shift the hero.
    //
    // So the trigger is taken out of the flow entirely: position:fixed in the
    // bottom-right corner, a layer of its own, touching nothing. Netflix keeps
    // that corner empty on every browse surface — its ribbons are top-left, its
    // hover previews grow from the row, its footer is below the fold — and the
    // corner is where a browser user already looks for an extension's own
    // controls. It is quiet at rest and only fully opaque under the pointer or
    // focus, so it reads as ours rather than as something Netflix added.
    //
    // Findability is then split between two paths: the corner for the person
    // who will discover it by looking, and Shift+G for the person who uses it
    // twice a day and should not have to aim at a corner.
    trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "nrx-genre-trigger";
    trigger.textContent = "Categories";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", "Browse Netflix's hidden categories");
    trigger.setAttribute("aria-keyshortcuts", "Shift+G");
    trigger.title = "Netflix's hidden categories (Shift+G)";
    trigger.addEventListener("click", () => (isOpen ? close() : open()));

    // A scrim rather than nothing, because focus is genuinely trapped while the
    // panel is open and the page behind it is genuinely inert. Light enough
    // that the row you were looking at is still legible behind it — this is a
    // panel you open mid-browse, and blacking out the reason you opened it
    // would be perverse.
    backdrop = document.createElement("div");
    backdrop.className = "nrx-genre-backdrop";
    backdrop.hidden = true;
    backdrop.addEventListener("click", close);

    panel = document.createElement("div");
    panel.className = "nrx-genre-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "nrx-genre-title");
    panel.addEventListener("keydown", onPanelKeydown);

    const header = document.createElement("div");
    header.className = "nrx-genre-header";

    const title = document.createElement("h2");
    title.className = "nrx-genre-title";
    title.id = "nrx-genre-title";
    title.textContent = "Hidden categories";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "nrx-genre-close";
    dismiss.textContent = "✕";
    dismiss.setAttribute("aria-label", "Close the category picker");
    dismiss.addEventListener("click", close);

    header.append(title, dismiss);

    const note = document.createElement("p");
    note.className = "nrx-genre-note";
    note.textContent =
      "Netflix files everything under numbered categories its rows never show you. " +
      "These pages are grids, so the badges and the rating sort work on them.";

    input = document.createElement("input");
    input.type = "text";
    input.className = "nrx-genre-search";
    input.placeholder = `Search ${TOTAL} categories, or paste a code`;
    input.setAttribute("aria-label", "Search categories");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "nrx-genre-list");
    input.setAttribute("aria-autocomplete", "list");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("input", () => render(input.value));

    statusEl = document.createElement("div");
    statusEl.className = "nrx-genre-status";
    // Polite rather than assertive: the count changes on every keystroke, and
    // this should land in the gaps in someone's typing, never on top of it.
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");

    listEl = document.createElement("div");
    listEl.className = "nrx-genre-list";
    listEl.id = "nrx-genre-list";
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Netflix categories");

    // Delegated, so a re-render never has to re-bind two hundred rows.
    //
    // Pointer and keyboard drive the same single highlight rather than each
    // having one of their own. Two highlights on screen at once is an ambiguous
    // answer to the only question the panel has to answer clearly: what does
    // Enter open.
    listEl.addEventListener("pointerover", (event) => {
      const target = event.target instanceof Element ? event.target.closest(".nrx-genre-option") : null;
      if (!target) return;
      const index = options.findIndex((entry) => entry.element === target);
      if (index >= 0 && index !== activeIndex) setActive(index, false);
    });

    // The anchor's own default navigation does the work, including every
    // modifier the browser already understands. This only gets the panel out of
    // the way first — and stays out of preventDefault entirely, so ⌘-click
    // still opens a background tab and leaves the picker where it was.
    listEl.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".nrx-genre-option")) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      close();
    });

    const footer = document.createElement("div");
    footer.className = "nrx-genre-footer";

    const keys = document.createElement("div");
    keys.className = "nrx-genre-keys";
    keys.textContent = `↑↓ to move · Enter opens · ${MOD_LABEL}+Enter opens a new tab · Esc closes`;

    // The dead-ID problem, said out loud. There is no way to know from here
    // whether a code still resolves — the check would be a request per row to a
    // page that answers 200 either way — so the only honest thing the panel can
    // do is decline to promise. Stated as a property of the list rather than
    // buried in a tooltip, because it applies to every row equally.
    const caveat = document.createElement("div");
    caveat.className = "nrx-genre-caveat";
    caveat.textContent =
      "Community-documented codes, not an official Netflix list. Netflix retires and " +
      "re-numbers categories without notice, and its catalogue differs by region — " +
      "a code that lands on an empty page is gone or not available where you are.";

    footer.append(keys, caveat);

    panel.append(header, note, input, statusEl, listEl, footer);
    container.append(trigger, backdrop, panel);
    return container;
  }

  // --- surviving Netflix ----------------------------------------------------
  function sync() {
    if (!pickerBelongsHere()) {
      close();
      if (root && root.isConnected) root.remove();
      return;
    }

    if (!root) root = build();

    // Re-appending the same element keeps every listener on it, so a Netflix
    // re-render that swept it away costs one appendChild rather than a rebuild
    // — and rebuilding would silently drop whatever the user had typed.
    if (!root.isConnected) document.body.appendChild(root);

    // Anything else claiming to be this picker — a stale copy from before a
    // re-render, or a second injection of this file — is removed rather than
    // left to sit under ours. This is what makes a duplicate trigger
    // impossible rather than merely unlikely.
    for (const stray of document.querySelectorAll(".nrx-genre-root")) {
      if (stray !== root) stray.remove();
    }
  }

  // Shift+G, for genres. content.js already established why plain Shift is the
  // free chord here: Netflix's own shortcuts are unmodified single keys and the
  // browser's are all Ctrl/Cmd/Alt, so nothing is being taken from either.
  // Capture, for the same reason as Shift+B — Netflix binds keys on the
  // document and stops propagation on the ones it claims.
  addEventListener("keydown", (event) => {
    if (!event.shiftKey || event.key.toLowerCase() !== "g") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // Includes our own search box, which is the point: Shift+G while typing is
    // a capital G, not a command.
    const target = event.target;
    if (target instanceof Element) {
      if (target.isContentEditable) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    }

    if (!pickerBelongsHere()) return;

    event.preventDefault();
    if (isOpen) close();
    else { sync(); open(); }
  }, { capture: true });

  // Escape at the document level rather than on the panel, and capturing, so it
  // beats Netflix's own Escape handling — which closes previews and exits the
  // player, and would otherwise fire underneath a dialog the user was trying to
  // dismiss.
  addEventListener("keydown", (event) => {
    if (!isOpen || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { capture: true });

  // The net under the Tab cycling: anything that lands focus outside an open
  // modal — Netflix moving focus itself, a click reaching the page behind the
  // scrim — is pulled straight back.
  addEventListener("focusin", (event) => {
    if (!isOpen || !panel) return;
    if (event.target instanceof Node && panel.contains(event.target)) return;
    input.focus();
  });

  // One page-lifetime observer, debounced the way content.js and sort.js
  // debounce theirs: Netflix rebuilds in bursts, and a burst should cost one
  // pass. Never disconnected, because it is the thing that notices our own
  // element being swept away — and sync() writes nothing when nothing changed,
  // so it cannot feed itself.
  let syncTimer = null;
  const pageObserver = new MutationObserver(() => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 300);
  });

  pageObserver.observe(document.body, { childList: true, subtree: true });

  // Netflix navigates client-side, and a Back that only changes the URL leaves
  // the observer nothing to see — which would leave the trigger sitting over
  // the player.
  addEventListener("popstate", sync);

  sync();
})();
