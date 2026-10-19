/* menu.js v40 — i18n-driven tooltips + dynamic messages (index/invite) + specials palette (visibility only here) */
(() => {
  'use strict';
  window.__ppMenuVer = 'v40';
  console.info('[menu] v40 loaded');

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const overlay   = $('#appMenuOverlay');
  const btnOpen   = $('#menuButton');
  const backdrop  = overlay ? $('.menu-backdrop', overlay) : null;

  const rowLang   = $('#langRow');
  const langLabel = $('#langCurrent');
  const flagA     = rowLang ? $('.flag-a', rowLang) : null;
  const flagB     = rowLang ? $('.flag-b', rowLang) : null;

  const rowAuto   = $('#rowAutoReveal');
  const swAuto    = $('#menuAutoRevealToggle');
  const rowTopic  = $('#rowTopic');
  const swTopic   = $('#menuTopicToggle');
  const rowPart   = $('#rowParticipation');
  const swPart    = $('#menuParticipationToggle');

  const rowSpecials = $('#rowSpecials');
  const swSpecials  = $('#menuSpecialsToggle');
  const rowSpecialsPick = $('#rowSpecialsPick');

  const rowHard    = $('#rowHardMode');
  const swHard     = $('#menuHardModeToggle');

  const seqRoot    = $('#menuSeqChoice');

  const closeBtn    = $('#closeRoomBtn');

  const getLang = () => window.PPUI.snapshot().language;
  const isDe = () => getLang() === 'de';
  const t = (key, fallback, params) => window.PPUI.message(key, fallback, params);
  /* ---------- open/close ---------- */
  const panel = overlay?.querySelector('.menu-panel');
  const dismiss = overlay?.querySelector('#menuCloseButton');
  let menuOpen = false;
  let invoker = null;
  let background = [];
  let scrollWasLocked = false;
  const isMenuOpen = () => menuOpen;
  const focusable = () => $$('button, a[href], input, select, textarea, [tabindex]', panel)
    .filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[inert]') &&
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  function setMenuButtonState(open) {
    if (!btnOpen) return;
    btnOpen.textContent = open ? '✕' : '☰';
    const labelOpen  = t('menu.open',  'Open menu');
    const labelClose = t('menu.close', 'Close menu');
    btnOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    btnOpen.setAttribute('aria-label', open ? labelClose : labelOpen);
    btnOpen.setAttribute('title',       open ? labelClose : labelOpen);
  }
  function forceRowLayout() {
    $$('.menu-item.switch').forEach((row) => {
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '24px 1fr max-content';
      row.style.alignItems = 'center';
      row.style.width = '100%';
      row.style.columnGap = '8px';
    });
    if (closeBtn) {
      closeBtn.style.display = 'grid';
      closeBtn.style.gridTemplateColumns = '24px 1fr';
      closeBtn.style.columnGap = '8px';
      const text = closeBtn.querySelector('.truncate-1');
      if (text) {
        text.style.whiteSpace = 'nowrap';
        text.style.overflow = 'hidden';
        text.style.textOverflow = 'ellipsis';
      }
    }
  }
  function openMenu(){
    if (!overlay || !panel || menuOpen) return;
    menuOpen = true;
    const active = document.activeElement;
    invoker = active === document.body || active === document.documentElement ? btnOpen : active;
    background = Array.from(document.body.children)
      .filter(el => el !== overlay && !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
      .map(el => ({ el, inert: el.inert }));
    background.forEach(({ el }) => { el.inert = true; });
    scrollWasLocked = document.documentElement.classList.contains('menu-scroll-locked');
    document.documentElement.classList.add('menu-scroll-locked');
    overlay.classList.remove('hidden');
    overlay.removeAttribute('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    setMenuButtonState(true);
    forceRowLayout();
    try { document.dispatchEvent(new CustomEvent('pp:menu-open')); } catch {}
    (dismiss || panel).focus({ preventScroll: true });
  }

  function closeMenu(){
    if (!overlay || !menuOpen) return;
    menuOpen = false;
    background.forEach(({ el, inert }) => { el.inert = inert; });
    background = [];
    if (!scrollWasLocked) document.documentElement.classList.remove('menu-scroll-locked');
    setMenuButtonState(false);
    const target = invoker?.isConnected && !invoker.closest('[inert]') ? invoker : btnOpen;
    target?.focus?.({ preventScroll: true });
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('hidden', '');
    invoker = null;
  }
  function toggleMenu(){ if (menuOpen) closeMenu(); else openMenu(); }
  btnOpen?.addEventListener('click', toggleMenu);
  dismiss?.addEventListener('click', closeMenu);
  backdrop?.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeMenu(); });
  // Capture Escape before nested palette handlers stop event propagation.
  document.addEventListener('keydown', (e) => {
    if (!menuOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      const items = focusable();
      const first = items[0], last = items[items.length - 1];
      if (!first) { e.preventDefault(); panel.focus(); }
      else if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    }
  }, true);
  document.addEventListener('focusin', (e) => {
    if (menuOpen && !panel.contains(e.target)) (focusable()[0] || panel).focus();
  });
  window.addEventListener('resize', () => {
    if (menuOpen && document.activeElement !== panel && !focusable().includes(document.activeElement)) {
      (dismiss || panel).focus({ preventScroll: true });
    }
  });
  /* ---------- Titles / tooltips ---------- */
  function setFunctionalTooltips(code) {
    const T = {
      auto    : t('hint.autoreveal',   'Automatically reveal once everyone voted'),
      topic   : t('hint.topic.toggle', 'Show or hide the Ticket/Story row'),
      specials: t('hint.specials',     'Allow special cards (❓ 💬 ☕)'),
      hard    : t('hint.hardmode',     'Reveal only when everyone voted'),
      part    : t('hint.participation','Toggle between estimator and spectator'),
      lang    : t('title.lang.to',     'Switch language \u2192 {0}', {0: isDe() ? 'English' : 'Deutsch'}),
      close   : t('room.close.hint',   'Closes this room for all participants and returns to the start page.')
    };
    rowLang?.setAttribute('title', T.lang);
    rowAuto?.setAttribute('title', T.auto);
    rowTopic?.setAttribute('title', T.topic);
    rowSpecials?.setAttribute('title', T.specials);
    rowHard?.setAttribute('title', T.hard);
    rowPart?.setAttribute('title', T.part);
    if (rowSpecialsPick) {
      // Keep a concise title on the palette itself; detailed per-icon tooltips come from data-i18n-attr
      const ttl = t('menu.specials.title', 'Special cards');
      rowSpecialsPick.setAttribute('title', ttl);
      rowSpecialsPick.setAttribute('aria-label', ttl);
    }
    if (closeBtn) closeBtn.setAttribute('title', T.close);
  }
  function setCloseBtnLabel() {
    if (!closeBtn) return;
    const labelEl = closeBtn.querySelector('.truncate-1') || closeBtn;
    labelEl.textContent = t('room.close', 'Close room for everyone');
    labelEl.classList.add('truncate-1');
    labelEl.style.whiteSpace = 'nowrap';
    labelEl.style.overflow = 'hidden';
    labelEl.style.textOverflow = 'ellipsis';
  }

  /* ---------- Specials palette (handled by specials-bridge.js) ---------- */
  // Only control visibility here; selection + events are owned by specials-bridge.js
  function specials_setPaletteVisible(show) {
    try {
      if (!rowSpecialsPick) return;
      rowSpecialsPick.hidden = !show;
      rowSpecialsPick.setAttribute('aria-hidden', show ? 'false' : 'true');
    } catch {}
  }

  /* ---------- Preference views: no local preference state or storage writes ---------- */
  function reflectPreferences(state) {
    if (langLabel) langLabel.textContent = state.language === 'de' ? 'Deutsch' : 'English';
    if (flagA && flagB) {
      flagA.src = state.language === 'de' ? '/flags/de.svg' : '/flags/us.svg';
      flagB.src = state.language === 'de' ? '/flags/at.svg' : '/flags/gb.svg';
    }
    setFunctionalTooltips(state.language);
    setCloseBtnLabel();
    setMenuButtonState(isMenuOpen());
  }
  window.PPUI.subscribe(reflectPreferences);
  rowLang?.addEventListener('click', () => window.PPUI.setLanguage(isDe() ? 'en' : 'de', 'menu'));
  /* ---------- Switch rows ---------- */
  function reflectAriaChecked(inputEl, rowEl) {
    if (!inputEl) return;
    const v = inputEl.checked ? 'true' : 'false';
    inputEl.setAttribute('aria-checked', v);
    if (rowEl?.getAttribute('role') === 'switch') rowEl.setAttribute('aria-checked', v);
    const roleSwitchEl = rowEl?.getAttribute('role') === 'switch' ? rowEl : inputEl.closest('[role="switch"]');
    if (roleSwitchEl && roleSwitchEl !== rowEl) roleSwitchEl.setAttribute('aria-checked', v);
  }
  function wireSwitchRow(rowEl, inputEl, onChange) {
    if (!rowEl || !inputEl) return;
    // Share ownership with room.js's fallback wiring: one change, one app event.
    const ownsDispatch = !inputEl.__bound;
    inputEl.__bound = true;
    rowEl.addEventListener('click', (e) => {
      if (e.target === inputEl || e.target.closest('input') === inputEl) return;
      if (inputEl.disabled) return;
      inputEl.checked = !inputEl.checked;
      reflectAriaChecked(inputEl, rowEl);
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    inputEl.addEventListener('change', () => {
      reflectAriaChecked(inputEl, rowEl);
      if (ownsDispatch) onChange?.(!!inputEl.checked);
    });
    reflectAriaChecked(inputEl, rowEl);
  }

  wireSwitchRow(rowAuto,  swAuto,  (on) => document.dispatchEvent(new CustomEvent('pp:auto-reveal-toggle',  { detail: { on } })));
  wireSwitchRow(rowTopic, swTopic, (on) => document.dispatchEvent(new CustomEvent('pp:topic-toggle',        { detail: { on } })));
  wireSwitchRow(rowPart,  swPart,  (on) => document.dispatchEvent(new CustomEvent('pp:participation-toggle',{ detail: { estimating: on } })));

  /* SPECIALS: behave like other rows (row-level toggling allowed) */
  wireSwitchRow(rowSpecials, swSpecials, (on) => {
  document.dispatchEvent(new CustomEvent('pp:specials-toggle', { detail: { on } }));
  });


  wireSwitchRow(rowHard,  swHard,  (on) => document.dispatchEvent(new CustomEvent('pp:hard-mode-toggle',    { detail: { on } })));

  closeBtn?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('pp:close-room'));
  });

  /* ---------- Sequence radios ---------- */
  const SPECIALS = new Set(['?', '❓', '☕', '∞']);
  const SEQ_FALLBACKS = {
    'fib.scrum': [0, 1, 2, 3, 5, 8, 13, 20, 40, 100],
    'fib.enh'  : [0, 0.5, 1, 2, 3, 5, 8, 13, 20, 40, 100, '∞', '❓', '☕'],
    'fib.math' : [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
    'pow2'     : [2, 4, 8, 16, 32, 64, 128],
    'tshirt'   : ['XS', 'S', 'M', 'L', 'XL', 'XXL']
  };
  function previewFromArray(arr) {
    const cleaned = (Array.isArray(arr) ? arr : []).filter(x => !SPECIALS.has(String(x)));
    const firstSix = cleaned.slice(0, 6).map(String);
    if (firstSix.length === 0) return '...';
    return `${firstSix.join(', ')},...`;
  }
  async function fetchSequences() {
    const candidates = ['/sequences', '/sequences/list'];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data)) {
          const map = {};
          data.forEach(it => {
            const id = it?.id || it?.name || it?.sequenceId;
            const cards = it?.cards || it?.values || it?.deck;
            if (id && Array.isArray(cards)) map[id] = cards;
          });
          if (Object.keys(map).length) return map;
        } else if (data && typeof data === 'object') {
          return data;
        }
      } catch {}
    }
    return SEQ_FALLBACKS;
  }
  function radiosSetEnabled(isHost){
    if (!seqRoot) return;
    const inputs = Array.from(seqRoot.querySelectorAll('input[type="radio"][name="menu-seq"]'));
    inputs.forEach(r => {
      r.disabled = !isHost;
      r.setAttribute('aria-disabled', String(!isHost));
      const label = r.closest('label');
      if (label) {
        label.classList.toggle('disabled', !isHost);
        if (!isHost) label.setAttribute('aria-disabled', 'true');
        else label.removeAttribute('aria-disabled');
      }
    });
  }
  function updateSeqRadiosEnabledFromBody(){
    const isHost = document.body.classList.contains('is-host');
    radiosSetEnabled(isHost);
  }
  updateSeqRadiosEnabledFromBody();
  new MutationObserver(updateSeqRadiosEnabledFromBody)
    .observe(document.body, { attributes:true, attributeFilter:['class'] });

  async function initSequenceTooltips() {
    if (!seqRoot) return;
    $$('input[type="radio"][name="menu-seq"]', seqRoot).forEach(r => {
      r.disabled = true;
      r.setAttribute('aria-disabled', 'true');
      r.closest('label')?.classList.add('disabled');
      r.closest('label')?.setAttribute('aria-disabled', 'true');
    });
    const seqMap = await fetchSequences();
    $$('label.radio-row', seqRoot).forEach(label => {
      const input = $('input[type="radio"]', label);
      if (!input) return;
      const id = input.value;
      const arr = seqMap[id] || SEQ_FALLBACKS[id] || [];
      const tip = previewFromArray(arr);
      label.setAttribute('title', tip);
    });
    updateSeqRadiosEnabledFromBody();
    seqRoot.addEventListener('change', (e) => {
      const r = e.target && e.target.closest('input[type="radio"][name="menu-seq"]');
      if (!r || r.disabled) return;
      const id = r.value;
      document.dispatchEvent(new CustomEvent('pp:sequence-change', { detail: { id } }));
    });
  }

  /* ---------- Specials visibility reactions ---------- */
  // Keep the palette row in sync with master switch; all selection logic lives in specials-bridge.js
  document.addEventListener('pp:specials-toggle', (e) => {
    const on = !!(e?.detail && e.detail.on);
    specials_setPaletteVisible(on);
  });

  /* ---------- init ---------- */
  (async function init() {
    await window.PPUI.ready;
    forceRowLayout();
    initSequenceTooltips();

    // After init, emit current specials ON/OFF only; selection is owned by specials-bridge.js
    if (swSpecials) {
      const aria = swSpecials.getAttribute('aria-checked');
      const on = aria === 'true' ? true : aria === 'false' ? false : !!swSpecials.checked;
      document.dispatchEvent(new CustomEvent('pp:specials-toggle', { detail: { on } }));
    }
  })();

})();
