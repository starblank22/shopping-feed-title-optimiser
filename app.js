/* ============================================================
   Shopping Feed Title Optimiser — app.js
   Everything runs client-side. No network calls except loading
   the parser libraries (PapaParse / SheetJS) on demand.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     1. SCORING CONFIGURATION
     --------------------------------------------------------- */

  // Base weights. Active rules are normalised to sum to 100 per row,
  // so paste mode (no GTIN / custom labels) still totals 100.
  var BASE = {
    length:        15,
    brand_first70: 20,
    front_loaded:  20,
    no_promo:      15,
    no_caps:        5,
    no_duplicates:  5,
    no_special:     5,
    gtin:          10,
    custom_labels:  5
  };

  var GRADE_COLORS = { A: 'a', B: 'b', C: 'c', D: 'd', F: 'f' };

  // Promotional / non-factual language (whole-word match).
  var PROMO_WORDS = ['sale', 'discount', 'best', 'cheap', 'new', 'hot',
    'limited', 'clearance', 'offer', 'bargain', 'bestseller'];
  var PROMO_PHRASES = ['free shipping', 'free delivery', 'buy now', 'top rated'];

  // Legitimate ALL-CAPS acronyms that should NOT be penalised.
  var CAPS_OK = new Set(['HDMI', 'OLED', 'QLED', 'WIFI', 'UPVC', 'VESA',
    'NVME', 'SATA', 'ANSI', 'LDPE', 'HDPE', 'XXXL', 'XXXXL', 'EPDM', 'XLPE']);

  var STOPWORDS = new Set(['the', 'and', 'for', 'with', 'plus', 'from',
    'your', 'our', 'set']);

  // Size / quantity detection.
  var SIZE_RE = /(^|[\s(\[\/])\d+(\.\d+)?\s?-?\s?(l|litre|litres|liter|liters|ltr|ml|cl|mm|cm|m|kg|g|gram|grams|inch|inches|in|ft|oz|lb|lbs|w|kw|watt|watts|"|”|tonne|amp|amps|v|volt|volts)\b/i;
  var DIM_RE  = /\b\d+(\.\d+)?\s?[x×]\s?\d+/i;
  var PACK_RE = /\b(pack|set|case|box|pair|bundle|roll|tier|sheet)s?\s+of\s+\d+\b|\b\d+\s?-?\s?(pack|piece|pieces|pcs|pc|sheet|sheets|roll|rolls|tier|seat|seater|drawer|drawers)\b/i;
  var SPAM_RE = /\|\||>>>?|<<<?|~~|--+|\*\*|!!|####|\.\.\.\.|\/\/\//;

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ---------------------------------------------------------
     2. CORE TITLE ANALYSERS
     --------------------------------------------------------- */

  function capsWords(title, brand) {
    var out = [], seen = {};
    var m = title.match(/\b[A-Z]{4,}\b/g) || [];
    var brandUp = brand ? brand.toUpperCase() : '';
    for (var i = 0; i < m.length; i++) {
      var w = m[i];
      if (CAPS_OK.has(w)) continue;
      if (brandUp && (brandUp === w || brandUp.indexOf(w) !== -1)) continue;
      if (seen[w]) continue;
      seen[w] = 1; out.push(w);
    }
    return out;
  }

  function duplicateWords(title) {
    var toks = title.toLowerCase().split(/[^a-z0-9]+/);
    var counts = {}, dups = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
      counts[t] = (counts[t] || 0) + 1;
    }
    for (var k in counts) if (counts[k] > 1) dups.push(k);
    return dups;
  }

  function hasSize(title) {
    return SIZE_RE.test(title) || DIM_RE.test(title) || PACK_RE.test(title);
  }

  function sizeMatch(title) {
    return title.match(SIZE_RE) || title.match(DIM_RE) || title.match(PACK_RE) || null;
  }

  /* ---------------------------------------------------------
     3. SCORING ENGINE
     --------------------------------------------------------- */

  // ctx: { gtinMapped, gtin, labelsMapped, labels:[] }
  function scoreTitle(rawTitle, rawBrand, ctx) {
    var title = (rawTitle == null ? '' : String(rawTitle)).trim();
    var lower = title.toLowerCase();
    var len = title.length;
    var brand = (rawBrand == null ? '' : String(rawBrand)).trim();
    var hasBrand = brand.length > 0;
    var basePattern = (hasBrand ? brand : '[Brand]') + ' → [Product Range] → [Key Spec] → [Size / Quantity]';

    // An empty title is categorically broken — score it 0 / F outright rather
    // than letting the "absence" rules (no promo, no caps…) award free credit.
    if (title === '') {
      return {
        title: '', brand: brand, score: 0, grade: 'F',
        tags: ['empty'],
        issues: ['The title is empty — there is nothing for Google to show shoppers or match against queries. Add a full product title.'],
        rules: [{
          id: 'length', label: 'Length 70–150 characters', base: 100, weight: 100,
          earned: 0, pass: false, detail: 'The title is empty.', tag: 'empty'
        }],
        pattern: basePattern
      };
    }

    var rules = [];

    /* --- Length --- */
    (function () {
      var earned, pass, detail, tag = null;
      if (len === 0) {
        earned = 0; pass = false; tag = 'empty';
        detail = 'The title is empty — nothing to show shoppers or match against queries.';
      } else if (len < 70) {
        earned = 0.3; pass = false; tag = 'too_short';
        detail = 'Title is ' + len + ' characters — under the 70-character floor. You are leaving Shopping real estate unused; add material, colour, size or model.';
      } else if (len <= 150) {
        earned = 1; pass = true;
        detail = 'Title is ' + len + ' characters — inside the 70–150 sweet spot.';
      } else {
        earned = 0.2; pass = false; tag = 'too_long';
        detail = 'Title is ' + len + ' characters — over 150. Google truncates long titles; trim to the essentials.';
      }
      rules.push({ id: 'length', label: 'Length 70–150 characters', base: BASE.length, earned: earned, pass: pass, detail: detail, tag: tag });
    })();

    /* --- Brand in first 70 chars (only when brand is known) --- */
    if (hasBrand) {
      var earned, pass, detail, tag = null;
      var pos = lower.indexOf(brand.toLowerCase());
      if (pos === -1) {
        earned = 0; pass = false; tag = 'no_brand';
        detail = 'Brand "' + brand + '" does not appear anywhere in the title.';
      } else if (pos < 70) {
        earned = 1; pass = true;
        detail = 'Brand "' + brand + '" appears within the first 70 characters.';
      } else {
        earned = 0.2; pass = false; tag = 'brand_buried';
        detail = 'Brand "' + brand + '" first appears at character ' + (pos + 1) + ' — past the 70-character cut-off. Move it to the front so it survives truncation.';
      }
      rules.push({ id: 'brand_first70', label: 'Brand inside first 70 characters', base: BASE.brand_first70, earned: earned, pass: pass, detail: detail, tag: tag });
    }

    /* --- Front-loaded structure: Brand -> Range -> Spec -> Size --- */
    (function () {
      var sized = hasSize(title);
      var brandFront = null;
      if (hasBrand) {
        var bp = lower.indexOf(brand.toLowerCase());
        brandFront = bp !== -1 && bp <= Math.max(12, Math.floor(len * 0.25));
      }
      var sizeLast = false;
      if (sized) {
        var m = sizeMatch(title);
        if (m) {
          var idx = title.indexOf(m[0].trim().length ? m[0] : title);
          sizeLast = idx >= len * 0.6;
        }
      }
      var earned = 0;
      if (hasBrand) {
        earned += brandFront ? 0.4 : 0;
        earned += sized ? 0.4 : 0;
        earned += sizeLast ? 0.2 : 0;
      } else {
        earned += sized ? 0.7 : 0;
        earned += sizeLast ? 0.3 : 0;
      }
      earned = Math.min(1, earned);
      var pass = earned >= 0.8, detail, tag = null;
      if (!sized) {
        tag = 'no_size';
        detail = 'No size or quantity token found (e.g. "24 Litre", "50cm", "Pack of 4"). Shoppers filter and compare on size — give them the number.';
      } else if (hasBrand && !brandFront) {
        tag = 'not_frontloaded';
        detail = 'Brand sits mid-title. Lead with Brand → Range → Spec → Size so the title reads cleanly front-to-back.';
      } else if (!sizeLast) {
        if (!pass) tag = 'weak_structure';
        detail = 'Structure is close — keep the size/quantity toward the end for a clean Brand → Range → Spec → Size read.';
      } else {
        detail = 'Well structured: brand leads and a size token is present and well placed.';
      }
      rules.push({ id: 'front_loaded', label: 'Front-loaded Brand → Range → Spec → Size', base: BASE.front_loaded, earned: earned, pass: pass, detail: detail, tag: tag });
    })();

    /* --- No promotional language --- */
    var capList = capsWords(title, brand);
    (function () {
      var hits = [];
      PROMO_WORDS.forEach(function (w) {
        if (new RegExp('\\b' + escapeRe(w) + '\\b', 'i').test(title)) hits.push(w);
      });
      PROMO_PHRASES.forEach(function (p) {
        if (new RegExp(escapeRe(p), 'i').test(title)) hits.push(p);
      });
      if (/%\s*off|\b\d+\s?%/i.test(title)) hits.push('% off');
      if (title.indexOf('★') !== -1 || title.indexOf('✦') !== -1 || title.indexOf('✓') !== -1) hits.push('★');
      if (title.indexOf('!') !== -1) hits.push('!');
      capList.forEach(function (c) { hits.push('ALL-CAPS “' + c + '”'); });

      var n = hits.length;
      var earned = n === 0 ? 1 : Math.max(0, 1 - 0.34 * n);
      var pass = n === 0;
      var detail = pass
        ? 'Clean, factual title — no promotional language.'
        : 'Promotional / non-factual language found: ' + hits.slice(0, 6).join(', ') +
          (hits.length > 6 ? '…' : '') + '. Google ranks factual titles higher and promo text can trigger disapprovals.';
      rules.push({ id: 'no_promo', label: 'No promotional language', base: BASE.no_promo, earned: earned, pass: pass, detail: detail, tag: pass ? null : 'promo_language' });
    })();

    /* --- No ALL-CAPS words (lighter separate penalty) --- */
    (function () {
      var pass = capList.length === 0;
      var detail = pass
        ? 'No shouting ALL-CAPS words.'
        : 'ALL-CAPS word(s): ' + capList.join(', ') + '. Capitalise normally — titles that shout look like spam and may be disapproved.';
      rules.push({ id: 'no_caps', label: 'No ALL-CAPS words', base: BASE.no_caps, earned: pass ? 1 : 0, pass: pass, detail: detail, tag: pass ? null : 'all_caps' });
    })();

    /* --- No duplicate words --- */
    (function () {
      var dups = duplicateWords(title);
      var pass = dups.length === 0;
      var detail = pass
        ? 'No duplicate words.'
        : 'Repeated word(s): ' + dups.join(', ') + '. Each duplicate wastes characters and reads like keyword stuffing.';
      rules.push({ id: 'no_duplicates', label: 'No duplicate words', base: BASE.no_duplicates, earned: pass ? 1 : 0, pass: pass, detail: detail, tag: pass ? null : 'duplicate_words' });
    })();

    /* --- No special-character spam --- */
    (function () {
      var pass = !SPAM_RE.test(title);
      var detail = pass
        ? 'No special-character spam.'
        : 'Special-character spam found (||, >>>, ~~, repeated hyphens). Use plain spacing — symbol clutter looks untrustworthy.';
      rules.push({ id: 'no_special', label: 'No special-character spam', base: BASE.no_special, earned: pass ? 1 : 0, pass: pass, detail: detail, tag: pass ? null : 'char_spam' });
    })();

    /* --- GTIN (feed mode, only if column mapped) --- */
    if (ctx && ctx.gtinMapped) {
      var raw = (ctx.gtin == null ? '' : String(ctx.gtin)).trim();
      var norm = raw.toLowerCase();
      var earned, pass, detail, tag = null;
      if (!raw || /^0+$/.test(raw) || ['n/a', 'na', 'none', 'null', '-', '#n/a'].indexOf(norm) !== -1) {
        earned = 0; pass = false; tag = 'missing_gtin';
        detail = 'GTIN is missing, zero or N/A. Products with a valid GTIN earn more impressions and lower CPCs.';
      } else if (/^\d{8}$|^\d{12,14}$/.test(raw.replace(/[\s-]/g, ''))) {
        earned = 1; pass = true;
        detail = 'Valid GTIN present.';
      } else {
        earned = 0.5; pass = false; tag = 'invalid_gtin';
        detail = 'GTIN "' + raw + '" is not a standard 8/12/13/14-digit barcode — double-check it.';
      }
      rules.push({ id: 'gtin', label: 'Valid GTIN present', base: BASE.gtin, earned: earned, pass: pass, detail: detail, tag: tag });
    }

    /* --- Custom labels (feed mode, only if mapped) --- */
    if (ctx && ctx.labelsMapped) {
      var any = (ctx.labels || []).some(function (v) { return v != null && String(v).trim() !== ''; });
      var detail = any
        ? 'At least one custom label is populated — good for bid segmentation.'
        : 'No custom labels populated. Custom labels let you segment bids by margin, season or bestseller status.';
      rules.push({ id: 'custom_labels', label: 'At least one custom label populated', base: BASE.custom_labels, earned: any ? 1 : 0, pass: any, detail: detail, tag: any ? null : 'no_custom_labels' });
    }

    /* --- Normalise weights & total --- */
    var baseSum = rules.reduce(function (s, r) { return s + r.base; }, 0);
    var score = 0;
    rules.forEach(function (r) {
      r.weight = r.base / baseSum * 100;
      score += r.earned * r.weight;
    });
    score = Math.round(score);

    var grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

    var tags = [], issues = [];
    rules.forEach(function (r) {
      if (!r.pass) {
        if (r.tag) tags.push(r.tag);
        issues.push(r.detail);
      }
    });

    return {
      title: title, brand: brand, score: score, grade: grade,
      tags: tags, issues: issues, rules: rules, pattern: basePattern
    };
  }

  /* ---------------------------------------------------------
     4. STATE
     --------------------------------------------------------- */

  var state = {
    mode: 'paste',
    results: [],          // scored result objects (+ .index, .row)
    feedRows: [],         // original parsed row objects
    feedColumns: [],      // ordered original column names
    mapping: {},          // { title, brand, gtin, labels:[] }
    sort: 'score-asc',
    gradeFilter: 'all',
    search: '',
    displayCount: 100
  };

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------
     5. EXTERNAL LIBRARY LOADER (lazy, keeps page load lean)
     --------------------------------------------------------- */

  var libCache = {};
  function loadScript(url) {
    if (libCache[url]) return libCache[url];
    libCache[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load ' + url)); };
      document.head.appendChild(s);
    });
    return libCache[url];
  }
  function ensurePapa() {
    if (window.Papa) return Promise.resolve(window.Papa);
    return loadScript('https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js')
      .then(function () { return window.Papa; });
  }
  function ensureXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js')
      .then(function () { return window.XLSX; });
  }

  /* ---------------------------------------------------------
     6. THEME
     --------------------------------------------------------- */

  function initTheme() {
    var btn = $('themeToggle');
    function sync() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.setAttribute('aria-pressed', String(dark));
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#0c0e13' : '#4f46e5');
    }
    sync();
    btn.addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      var next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('sfto-theme', next); } catch (e) {}
      sync();
    });
  }

  /* ---------------------------------------------------------
     7. TABS
     --------------------------------------------------------- */

  function initTabs() {
    var tabs = [$('tab-paste'), $('tab-upload')];
    var panels = { 'tab-paste': $('panel-paste'), 'tab-upload': $('panel-upload') };
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activate(tab); });
    });
    function activate(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var p = panels[t.id];
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
      state.mode = tab.id === 'tab-upload' ? 'feed' : 'paste';
      hideError();
    }
  }

  /* ---------------------------------------------------------
     8. ERROR HELPERS
     --------------------------------------------------------- */

  function showError(msg) {
    var e = $('toolError');
    e.textContent = msg; e.hidden = false;
  }
  function hideError() { $('toolError').hidden = true; }

  /* ---------------------------------------------------------
     9. PASTE MODE
     --------------------------------------------------------- */

  var SAMPLE_TITLES = [
    'Wham Storage Crystal Clear Plastic Box 24 Litre Stackable with Clip Lid Home Organiser',
    'Joseph Joseph Nest 9 Plus Compact Food Storage Container Set 9 Piece Stackable Kitchen',
    'CHEAP STORAGE BOXES SALE BUY NOW BEST PRICE FREE DELIVERY LIMITED OFFER',
    'Storage Box',
    'Plastic Storage Box Box Plastic Container with Lid Lid for the Home',
    '★ BEST KETTLE EVER ★ Buy Now !!! Huge Sale !!! Limited Stock',
    'Russell Hobbs Inspire Electric Kettle',
    'Brabantia NewIcon Pedal Bin 30 Litre Soft Close Stainless Steel Kitchen Waste Bin'
  ];
  var SAMPLE_BRANDS = ['Wham', 'Joseph Joseph', '', '', '', '', 'Russell Hobbs', 'Brabantia'];

  function initPaste() {
    $('samplePasteBtn').addEventListener('click', function () {
      $('titlesInput').value = SAMPLE_TITLES.join('\n');
      $('brandsInput').value = SAMPLE_BRANDS.join('\n');
      var d = $('brandsInput').closest('details');
      if (d) d.open = true;
      hideError();
    });
    $('clearPasteBtn').addEventListener('click', function () {
      $('titlesInput').value = '';
      $('brandsInput').value = '';
      hideError();
    });
    $('scorePasteBtn').addEventListener('click', scorePaste);
  }

  function scorePaste() {
    hideError();
    var titles = $('titlesInput').value.split('\n')
      .map(function (s) { return s.replace(/\s+$/, ''); });
    // Trim trailing empties but keep internal blanks aligned with brands.
    while (titles.length && titles[titles.length - 1].trim() === '') titles.pop();
    var nonEmpty = titles.filter(function (t) { return t.trim() !== ''; });
    if (nonEmpty.length === 0) {
      showError('Paste at least one product title to score.');
      return;
    }
    var brands = $('brandsInput').value.split('\n');

    var results = [];
    titles.forEach(function (t, i) {
      if (t.trim() === '') return;
      var r = scoreTitle(t, brands[i] || '', { gtinMapped: false, labelsMapped: false });
      r.index = results.length;
      r.row = { title: t, brand: (brands[i] || '').trim() };
      results.push(r);
    });

    state.mode = 'paste';
    state.results = results;
    state.feedColumns = [];
    finishScoring();
  }

  /* ---------------------------------------------------------
     10. FEED MODE — parsing & column mapping
     --------------------------------------------------------- */

  var COL_HINTS = {
    title: ['title', 'product_title', 'producttitle', 'name', 'product_name', 'productname', 'item_title'],
    brand: ['brand', 'manufacturer', 'brand_name', 'brandname', 'make'],
    gtin:  ['gtin', 'barcode', 'ean', 'upc', 'isbn']
  };

  function detectCol(columns, hints) {
    var lc = columns.map(function (c) { return String(c).toLowerCase().replace(/\s+/g, '_'); });
    for (var i = 0; i < hints.length; i++) {
      var idx = lc.indexOf(hints[i]);
      if (idx !== -1) return columns[idx];
    }
    return '';
  }
  function detectLabels(columns) {
    return columns.filter(function (c) {
      return /^custom[_ ]?label[_ ]?[0-4]$/i.test(String(c).trim());
    });
  }

  function initUpload() {
    var dz = $('dropzone'), input = $('fileInput');
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handleFile(input.files[0]);
    });
    $('sampleFeedBtn').addEventListener('click', loadSampleFeed);
    $('scoreFeedBtn').addEventListener('click', scoreFeed);
  }

  function handleFile(file) {
    hideError();
    if (file.size > 11 * 1024 * 1024) {
      showError('That file is larger than ~10 MB. Split it or export a smaller feed.');
      return;
    }
    var name = file.name.toLowerCase();
    if (/\.(xlsx|xls)$/.test(name)) {
      parseXlsx(file);
    } else if (/\.(csv|tsv|txt)$/.test(name)) {
      parseDelimited(file);
    } else {
      showError('Unsupported file type. Upload a .csv, .tsv or .xlsx feed.');
    }
  }

  function parseDelimited(fileOrText, label) {
    ensurePapa().then(function (Papa) {
      Papa.parse(fileOrText, {
        header: true,
        skipEmptyLines: 'greedy',
        dynamicTyping: false,
        transformHeader: function (h) { return String(h).trim(); },
        complete: function (res) {
          var cols = (res.meta && res.meta.fields) ? res.meta.fields.slice() : [];
          ingestFeed(cols, res.data, label || 'your feed');
        },
        error: function (err) { showError('Could not parse the file: ' + err.message); }
      });
    }).catch(function () {
      showError('Could not load the CSV parser. Check your connection and retry.');
    });
  }

  function parseXlsx(file) {
    ensureXlsx().then(function (XLSX) {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var sheet = wb.Sheets[wb.SheetNames[0]];
          var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
          if (!aoa.length) { showError('That spreadsheet looks empty.'); return; }
          var cols = aoa[0].map(function (c, i) {
            var v = String(c == null ? '' : c).trim();
            return v || ('Column ' + (i + 1));
          });
          var rows = [];
          for (var r = 1; r < aoa.length; r++) {
            var obj = {}, any = false;
            for (var c = 0; c < cols.length; c++) {
              var val = aoa[r][c];
              obj[cols[c]] = val == null ? '' : val;
              if (String(val).trim() !== '') any = true;
            }
            if (any) rows.push(obj);
          }
          ingestFeed(cols, rows, file.name);
        } catch (err) {
          showError('Could not read that spreadsheet: ' + err.message);
        }
      };
      reader.onerror = function () { showError('Could not read the file.'); };
      reader.readAsArrayBuffer(file);
    }).catch(function () {
      showError('Could not load the spreadsheet parser. Check your connection and retry.');
    });
  }

  function ingestFeed(columns, rows, sourceName) {
    columns = columns.filter(function (c) { return c != null && String(c) !== ''; });
    if (!columns.length || !rows.length) {
      showError('No data rows found in that file.');
      return;
    }
    state.feedColumns = columns;
    state.feedRows = rows;

    var titleCol = detectCol(columns, COL_HINTS.title);
    var brandCol = detectCol(columns, COL_HINTS.brand);
    var gtinCol  = detectCol(columns, COL_HINTS.gtin);
    var labelCols = detectLabels(columns);
    state.mapping = { title: titleCol, brand: brandCol, gtin: gtinCol, labels: labelCols };

    var status = $('parseStatus');
    status.hidden = false;
    status.innerHTML = 'Parsed <strong>' + rows.length.toLocaleString() + '</strong> rows and ' +
      '<strong>' + columns.length + '</strong> columns from ' + escapeHtml(sourceName) +
      (titleCol ? '. Title column auto-detected as <strong>' + escapeHtml(titleCol) + '</strong>.'
                : '. <strong>Pick the title column below</strong> to continue.');

    renderMapping();
    $('mappingPanel').hidden = false;
    $('mappingPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderMapping() {
    var grid = $('mappingGrid');
    grid.innerHTML = '';
    var cols = state.feedColumns;

    function selectField(key, labelText, required, multi) {
      var wrap = el('div', 'map-field' + (required ? ' is-required' : ''));
      var id = 'map-' + key;
      var lab = el('label', null, escapeHtml(labelText));
      lab.htmlFor = id;
      wrap.appendChild(lab);
      var sel = el('select');
      sel.id = id;
      if (!required && !multi) {
        var none = el('option', null, '— none —');
        none.value = '';
        sel.appendChild(none);
      }
      cols.forEach(function (c) {
        var o = el('option', null, escapeHtml(c));
        o.value = c;
        sel.appendChild(o);
      });
      sel.value = state.mapping[key] || '';
      sel.addEventListener('change', function () {
        state.mapping[key] = sel.value;
        updateScoreFeedEnabled();
      });
      wrap.appendChild(sel);
      grid.appendChild(wrap);
    }

    selectField('title', 'Title column', true, false);
    selectField('brand', 'Brand column', false, false);
    selectField('gtin', 'GTIN column', false, false);

    // Custom labels — info row (auto-detected).
    var lab = el('div', 'map-field');
    lab.innerHTML = '<label>Custom labels</label>';
    var info = el('select');
    var opt = el('option', null,
      state.mapping.labels.length
        ? state.mapping.labels.length + ' detected: ' + state.mapping.labels.join(', ')
        : 'none detected');
    info.appendChild(opt);
    info.disabled = true;
    lab.appendChild(info);
    grid.appendChild(lab);

    updateScoreFeedEnabled();
  }

  function updateScoreFeedEnabled() {
    $('scoreFeedBtn').disabled = !state.mapping.title;
  }

  function loadSampleFeed() {
    hideError();
    fetch('assets/sample-feed.csv')
      .then(function (r) {
        if (!r.ok) throw new Error('not found');
        return r.text();
      })
      .then(function (text) { parseDelimited(text, 'the 50-row sample feed'); })
      .catch(function () {
        showError('Could not load the sample feed. If you are running this locally, download sample-feed.csv from the assets folder and upload it.');
      });
  }

  function scoreFeed() {
    hideError();
    var m = state.mapping;
    if (!m.title) { showError('Choose which column holds the product title.'); return; }

    var results = [];
    state.feedRows.forEach(function (row) {
      var title = row[m.title];
      var brand = m.brand ? row[m.brand] : '';
      var ctx = {
        gtinMapped: !!m.gtin,
        gtin: m.gtin ? row[m.gtin] : undefined,
        labelsMapped: m.labels.length > 0,
        labels: m.labels.map(function (c) { return row[c]; })
      };
      var r = scoreTitle(title, brand, ctx);
      r.index = results.length;
      r.row = row;
      results.push(r);
    });

    state.mode = 'feed';
    state.results = results;
    finishScoring();
  }

  /* ---------------------------------------------------------
     11. ORCHESTRATION AFTER SCORING
     --------------------------------------------------------- */

  function finishScoring() {
    state.sort = 'score-asc';
    state.gradeFilter = 'all';
    state.search = '';
    state.displayCount = 100;
    $('searchInput').value = '';
    $('sortSelect').value = 'score-asc';
    $('gradeFilters').querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.grade === 'all');
    });

    renderSummary();
    renderTable();
    var sec = $('results');
    sec.hidden = false;
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------------------------------------------------
     12. SUMMARY RENDERING
     --------------------------------------------------------- */

  var ISSUE_PHRASES = {
    too_short:      'under 70 characters — leaving Shopping space unused',
    too_long:       'over 150 characters and will be truncated by Google',
    empty:          'have an empty title',
    no_brand:       'never mention the brand at all',
    brand_buried:   'bury the brand past the first 70 characters',
    no_size:        'are missing a size or quantity token',
    not_frontloaded:'are not front-loaded Brand → Range → Spec → Size',
    weak_structure: 'have a weak Brand → Range → Spec → Size structure',
    promo_language: 'contain promotional or non-factual language',
    all_caps:       'shout with ALL-CAPS words',
    duplicate_words:'repeat the same word more than once',
    char_spam:      'contain special-character spam',
    missing_gtin:   'are missing a valid GTIN',
    invalid_gtin:   'have a GTIN that is not a standard barcode',
    no_custom_labels:'have no custom labels populated for bid segmentation'
  };

  function renderSummary() {
    var res = state.results;
    var total = res.length;
    var sum = 0, dist = { A: 0, B: 0, C: 0, D: 0, F: 0 }, tagCount = {};
    res.forEach(function (r) {
      sum += r.score;
      dist[r.grade]++;
      var seen = {};
      r.tags.forEach(function (t) {
        if (seen[t]) return; seen[t] = 1;
        tagCount[t] = (tagCount[t] || 0) + 1;
      });
    });
    var avg = total ? Math.round(sum / total) : 0;
    var ab = dist.A + dist.B;
    var df = dist.D + dist.F;

    $('resultsMeta').textContent = state.mode === 'feed'
      ? 'Scored every title in your feed against ' + (Object.keys(BASE).length) + ' best-practice rules. Worst offenders first.'
      : 'Scored ' + total + ' pasted title' + (total === 1 ? '' : 's') + ' against best-practice rules. Worst offenders first.';

    // Stat cards
    var grid = $('statGrid');
    grid.innerHTML = '';
    function stat(value, label, sub) {
      var c = el('div', 'stat');
      c.innerHTML = '<div class="stat__value">' + value + '</div>' +
        '<div class="stat__label">' + label + '</div>' +
        (sub ? '<div class="stat__sub">' + sub + '</div>' : '');
      return c;
    }
    grid.appendChild(stat(total.toLocaleString(), 'Titles scored', state.mode === 'feed' ? 'from your feed' : 'pasted in'));
    grid.appendChild(stat(avg + '<span style="font-size:1rem;color:var(--text-3)">/100</span>',
      'Average score', gradeFor(avg) + ' grade overall'));
    grid.appendChild(stat(pct(ab, total), 'A &amp; B grade', ab.toLocaleString() + ' solid titles'));
    grid.appendChild(stat(df.toLocaleString(), 'D &amp; F grade', 'need urgent attention'));

    // Grade chart
    var chart = $('gradeChart');
    chart.innerHTML = '';
    ['A', 'B', 'C', 'D', 'F'].forEach(function (g) {
      var n = dist[g];
      var row = el('div', 'gc-row');
      row.innerHTML =
        '<span class="gc-label g-' + g + '">' + g + '</span>' +
        '<span class="gc-track"><span class="gc-fill g-' + g + '" style="width:' +
          (total ? (n / total * 100) : 0).toFixed(1) + '%"></span></span>' +
        '<span class="gc-count">' + n + ' &middot; ' + pct(n, total) + '</span>';
      chart.appendChild(row);
    });

    // Top issues
    var issuesUl = $('topIssues');
    issuesUl.innerHTML = '';
    var ranked = Object.keys(tagCount).map(function (t) {
      return { tag: t, count: tagCount[t] };
    }).sort(function (a, b) { return b.count - a.count; });

    if (!ranked.length) {
      issuesUl.innerHTML = '<li class="empty">No rule failures detected — this feed is in great shape.</li>';
    } else {
      ranked.slice(0, 3).forEach(function (it) {
        var li = el('li');
        li.innerHTML = '<span class="ti-pct">' + pct(it.count, total) + '</span>' +
          '<span class="ti-text">of titles ' + (ISSUE_PHRASES[it.tag] || it.tag) +
          ' <strong>(' + it.count.toLocaleString() + ')</strong></span>';
        issuesUl.appendChild(li);
      });
    }

    // Opportunity callout
    var opp = $('opportunity');
    if (df > 0) {
      opp.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>' +
        '<p>Fixing the <strong>' + df.toLocaleString() + ' D/F-grade title' + (df === 1 ? '' : 's') +
        '</strong> is the single highest-leverage change you can make to Shopping performance — ' +
        'that is <strong>' + pct(df, total) + '</strong> of this ' + (state.mode === 'feed' ? 'feed' : 'list') +
        ' actively holding back your impressions and CTR. Start at the top of the table.</p>';
      opp.style.display = '';
    } else {
      opp.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
        '<p>No D or F-grade titles — strong work. Sort by worst score and tighten the C-grades next for incremental gains.</p>';
      opp.style.display = '';
    }
  }

  function gradeFor(s) {
    return s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F';
  }
  function pct(n, total) {
    if (!total) return '0%';
    return Math.round(n / total * 100) + '%';
  }

  /* ---------------------------------------------------------
     13. TABLE RENDERING
     --------------------------------------------------------- */

  function getFiltered() {
    var res = state.results.slice();
    if (state.gradeFilter !== 'all') {
      res = res.filter(function (r) { return r.grade === state.gradeFilter; });
    }
    if (state.search) {
      var q = state.search.toLowerCase();
      res = res.filter(function (r) { return r.title.toLowerCase().indexOf(q) !== -1; });
    }
    if (state.sort === 'score-asc') res.sort(function (a, b) { return a.score - b.score || a.index - b.index; });
    else if (state.sort === 'score-desc') res.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    else res.sort(function (a, b) { return a.index - b.index; });
    return res;
  }

  function renderTable() {
    var filtered = getFiltered();
    var body = $('resultsBody');
    body.innerHTML = '';
    var shown = filtered.slice(0, state.displayCount);

    if (!filtered.length) {
      var tr = el('tr');
      tr.innerHTML = '<td colspan="5"><div class="empty-state">No titles match this filter or search.</div></td>';
      body.appendChild(tr);
    } else {
      shown.forEach(function (r) {
        body.appendChild(buildRow(r));
        body.appendChild(buildDetail(r));
      });
    }

    $('tableCount').textContent = 'Showing ' + shown.length.toLocaleString() +
      ' of ' + filtered.length.toLocaleString() + ' title' + (filtered.length === 1 ? '' : 's') +
      (state.gradeFilter !== 'all' ? ' · grade ' + state.gradeFilter : '') +
      (state.search ? ' · matching “' + state.search + '”' : '');

    var more = $('loadMoreBtn');
    more.hidden = shown.length >= filtered.length;
  }

  function buildRow(r) {
    var tr = el('tr', 'row-main');
    tr.dataset.idx = r.index;

    var tagHtml = r.tags.length
      ? r.tags.slice(0, 4).map(function (t) {
          return '<span class="tag tag--bad">' + escapeHtml(t) + '</span>';
        }).join('') + (r.tags.length > 4 ? '<span class="tag">+' + (r.tags.length - 4) + '</span>' : '')
      : '<span class="tag tag--ok">all checks passed</span>';

    tr.innerHTML =
      '<td class="cell-caret-wrap"><button class="caret-btn" type="button" aria-expanded="false" aria-label="Toggle rule breakdown for this title"><svg class="cell-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button></td>' +
      '<td class="cell-title"><span class="titletext">' + escapeHtml(r.title || '(empty title)') + '</span></td>' +
      '<td class="cell-score"><span class="score-num" style="color:var(--grade-' + GRADE_COLORS[r.grade] + ')">' + r.score + '</span></td>' +
      '<td class="cell-grade"><span class="grade-badge g-' + r.grade + '">' + r.grade + '</span></td>' +
      '<td class="cell-issues">' + tagHtml + '</td>';
    return tr;
  }

  function buildDetail(r) {
    var tr = el('tr', 'row-detail');
    tr.hidden = true;
    tr.dataset.detail = r.index;

    var rulesHtml = r.rules.map(function (rule) {
      var icon = rule.pass
        ? '<svg class="rule-icon pass" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<svg class="rule-icon fail" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      return '<div class="rule-item">' + icon +
        '<div><div class="rule-name">' + escapeHtml(rule.label) + '</div>' +
        '<div class="rule-detail">' + escapeHtml(rule.detail) + '</div></div>' +
        '<div class="rule-weight">wt ' + Math.round(rule.weight) + '</div></div>';
    }).join('');

    var inner =
      '<div class="detail-inner"><div class="detail-grid">' +
        '<div><div class="detail-h">Rule-by-rule breakdown</div><div class="rule-list">' + rulesHtml + '</div></div>' +
        '<div><div class="detail-h">Suggested rewrite pattern</div>' +
          '<div class="pattern-box"><code>' + escapeHtml(r.pattern) + '</code>' +
          '<span class="eg">Example of the pattern in action:<br>“Wham Storage Crystal Clear Plastic Box 24 Litre Stackable”</span></div>' +
          (r.issues.length
            ? '<div class="detail-h" style="margin-top:16px">What to fix</div><div class="rule-list">' +
              r.issues.map(function (i) {
                return '<div class="rule-detail" style="padding-left:0">• ' + escapeHtml(i) + '</div>';
              }).join('') + '</div>'
            : '') +
        '</div>' +
      '</div></div>';

    var td = el('td');
    td.colSpan = 5;
    td.innerHTML = inner;
    tr.appendChild(td);
    return tr;
  }

  function initTableControls() {
    $('resultsBody').addEventListener('click', function (e) {
      var row = e.target.closest('.row-main');
      if (!row) return;
      var detail = $('resultsBody').querySelector('tr.row-detail[data-detail="' + row.dataset.idx + '"]');
      if (!detail) return;
      var open = !detail.hidden;
      detail.hidden = open;
      row.classList.toggle('is-open', !open);
      var btn = row.querySelector('.caret-btn');
      if (btn) btn.setAttribute('aria-expanded', String(!open));
    });

    $('sortSelect').addEventListener('change', function () {
      state.sort = this.value; state.displayCount = 100; renderTable();
    });
    var searchT;
    $('searchInput').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(searchT);
      searchT = setTimeout(function () {
        state.search = v.trim(); state.displayCount = 100; renderTable();
      }, 130);
    });
    $('gradeFilters').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      state.gradeFilter = chip.dataset.grade;
      state.displayCount = 100;
      this.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-active', c === chip);
      });
      renderTable();
    });
    $('loadMoreBtn').addEventListener('click', function () {
      state.displayCount += 150; renderTable();
    });
  }

  /* ---------------------------------------------------------
     14. DOWNLOAD SCORED CSV
     --------------------------------------------------------- */

  function initDownload() {
    $('downloadBtn').addEventListener('click', function () {
      if (!state.results.length) return;
      ensurePapa().then(function (Papa) {
        var fields, data;
        if (state.mode === 'feed') {
          fields = state.feedColumns.slice();
          ['feed_score', 'feed_grade', 'feed_issues', 'feed_suggested_pattern']
            .forEach(function (f) { if (fields.indexOf(f) === -1) fields.push(f); });
          data = state.results.map(function (r) {
            var o = {};
            state.feedColumns.forEach(function (c) { o[c] = r.row[c]; });
            o.feed_score = r.score;
            o.feed_grade = r.grade;
            o.feed_issues = r.tags.join(', ');
            o.feed_suggested_pattern = r.pattern;
            return o;
          });
        } else {
          var hasBrand = state.results.some(function (r) { return r.brand; });
          fields = ['title'];
          if (hasBrand) fields.push('brand');
          fields = fields.concat(['feed_score', 'feed_grade', 'feed_issues', 'feed_suggested_pattern']);
          data = state.results.map(function (r) {
            var o = { title: r.title };
            if (hasBrand) o.brand = r.brand;
            o.feed_score = r.score;
            o.feed_grade = r.grade;
            o.feed_issues = r.tags.join(', ');
            o.feed_suggested_pattern = r.pattern;
            return o;
          });
        }
        var csv = Papa.unparse({ fields: fields, data: data });
        downloadText(csv, 'scored-feed.csv', 'text/csv');
      }).catch(function () {
        showResultsToast('Could not load the CSV writer — check your connection.');
      });
    });
  }

  function downloadText(text, filename, mime) {
    var blob = new Blob(['﻿' + text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function showResultsToast(msg) { alert(msg); }

  /* ---------------------------------------------------------
     15. AI REWRITE PROMPT
     --------------------------------------------------------- */

  function buildPrompt(n) {
    var worst = state.results.slice().sort(function (a, b) {
      return a.score - b.score || a.index - b.index;
    }).slice(0, n);

    var brands = {};
    worst.forEach(function (r) { if (r.brand) brands[r.brand] = 1; });
    var brandList = Object.keys(brands);
    var brandLine = brandList.length
      ? brandList.slice(0, 30).join(', ') + (brandList.length > 30 ? ', …' : '')
      : 'Not supplied — infer the brand from each title where one is obvious, otherwise leave the brand out rather than guessing.';

    var titleLines = worst.map(function (r, i) {
      return (i + 1) + '. ' + r.title + (r.brand ? '   [brand: ' + r.brand + ']' : '');
    }).join('\n');

    return [
'You are a senior Google Shopping feed specialist. Rewrite the product titles below to maximise',
'Shopping / Performance Max click-through rate and query coverage, without overstating anything.',
'',
'## How Google reads a title',
'Google builds the ad from the feed — the title is the single biggest input into which searches a',
'product shows for. It reads left-to-right; the first ~70 characters carry the most matching weight',
'and are what most shoppers see before the title is truncated.',
'',
'## Rules — every rewritten title MUST:',
'1. Follow the structure  Brand → Product Range/Model → Key Attribute/Spec → Size/Quantity.',
'2. Be 70–150 characters long. Use the space — add material, colour, model, variant — but never pad',
'   with filler. Under 70 wastes coverage; over 150 gets truncated.',
'3. Put the brand and the most important spec inside the first 70 characters.',
'4. Include a concrete size or quantity token wherever one plausibly exists (e.g. "24 Litre",',
'   "50cm", "Pack of 4", "1.7L"). Shoppers filter and compare on size.',
'5. Contain ZERO promotional or non-factual language: no "sale", "best", "cheap", "free delivery",',
'   "buy now", "limited", "%", exclamation marks, stars, or ALL-CAPS words.',
'6. Use no duplicate words and no special-character spam (||, >>>, ~~, repeated hyphens).',
'7. Stay truthful to the product — never invent specs, sizes or materials that are not implied by',
'   the original title. If a spec is unknown, leave a clearly bracketed placeholder like [SIZE].',
'',
'## Brand context',
brandLine,
'',
'## Titles to rewrite (' + worst.length + ' lowest-scoring titles)',
titleLines,
'',
'## Output format',
'Return ONLY a markdown table with exactly these columns and one row per title:',
'',
'| # | Original | Rewritten | What changed & why |',
'|---|----------|-----------|--------------------|',
'',
'Keep "What changed & why" to one tight sentence written for a PPC manager (e.g. "Moved brand to',
'the front and added the 24 L capacity so the title front-loads and survives truncation."). Do not',
'add commentary outside the table.'
    ].join('\n');
  }

  function refreshPrompt() {
    var n = parseInt($('promptCount').value, 10) || 25;
    n = Math.min(n, state.results.length);
    $('promptText').value = buildPrompt(n);
  }

  function initModal() {
    var modal = $('promptModal');
    $('promptBtn').addEventListener('click', function () {
      if (!state.results.length) return;
      refreshPrompt();
      $('copyStatus').textContent = '';
      if (typeof modal.showModal === 'function') modal.showModal();
      else modal.setAttribute('open', '');
    });
    $('promptCount').addEventListener('change', refreshPrompt);
    $('closeModalBtn').addEventListener('click', function () { modal.close(); });
    modal.addEventListener('click', function (e) {
      // Click on the backdrop (the dialog element itself) closes it.
      if (e.target === modal) modal.close();
    });
    $('copyPromptBtn').addEventListener('click', function () {
      var text = $('promptText').value;
      var done = function () {
        $('copyStatus').textContent = '✓ Copied — paste it into your AI of choice';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          legacyCopy(); done();
        });
      } else { legacyCopy(); done(); }
      function legacyCopy() {
        var ta = $('promptText');
        ta.removeAttribute('readonly');
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.setAttribute('readonly', '');
        window.getSelection().removeAllRanges();
      }
    });
  }

  /* ---------------------------------------------------------
     16. INIT
     --------------------------------------------------------- */

  function init() {
    initTheme();
    initTabs();
    initPaste();
    initUpload();
    initTableControls();
    initDownload();
    initModal();
    updateScoreFeedEnabled();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Expose the scoring engine for self-tests / power users. */
  window.SFTO = { scoreTitle: scoreTitle };
})();
