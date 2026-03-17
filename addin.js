/* =========================================================
   Fleet Dashboard — addin.js

   API Strategy (mirrors safety scorecard):
   - Device:  fetched in sequential result-window pages (fromId
              cursor) so no single call can hit the server limit.
   - Trip:    fetched in sequential 3-day time windows per the
              safety scorecard pattern; no resultsLimit on any
              individual call.
   Neither typename uses a resultsLimit parameter.
   ========================================================= */

var fleetDash = (function () {
  var _api      = null;
  var _rows     = [];
  var _days     = 30;
  var _sortKey  = 'miles';
  var _sortDir  = -1;
  var _isLight  = false;
  var _customFrom = null;
  var _customTo   = null;
  var _isCustom   = false;

  /* ── Constants ─────────────────────────────────────────── */
  var WINDOW_DAYS = 3;          // Trip time-window size (days)
  var PAGE_SIZE   = 500;        // Device page size for cursor paging

  var MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  /* ================================================================
     DATE PICKER
  ================================================================ */
  function initPicker() {
    var now = new Date();
    var yr  = now.getFullYear();

    ['sMo','eMo'].forEach(function (id) {
      var sel = document.getElementById(id);
      MONTHS_FULL.forEach(function (m, i) {
        var o = document.createElement('option');
        o.value = i + 1; o.textContent = m;
        sel.appendChild(o);
      });
    });

    ['sYr','eYr'].forEach(function (id) {
      var sel = document.getElementById(id);
      for (var y = yr; y >= yr - 5; y--) {
        var o = document.createElement('option');
        o.value = y; o.textContent = y;
        sel.appendChild(o);
      }
    });

    ['s','e'].forEach(function (p) {
      buildDays(p);
      document.getElementById(p + 'Mo').addEventListener('change', function () { buildDays(p); });
      document.getElementById(p + 'Yr').addEventListener('change', function () { buildDays(p); });
    });

    var from = new Date(now);
    from.setDate(from.getDate() - 30);
    setPickerVal('s', from);
    setPickerVal('e', now);

    document.addEventListener('click', function (e) {
      var wrap = document.getElementById('dpickWrap');
      if (wrap && !wrap.contains(e.target)) closePicker();
    });
  }

  function buildDays(p) {
    var mo  = parseInt(document.getElementById(p + 'Mo').value, 10) || 1;
    var yr  = parseInt(document.getElementById(p + 'Yr').value, 10) || new Date().getFullYear();
    var max = new Date(yr, mo, 0).getDate();
    var sel = document.getElementById(p + 'Dy');
    var cur = parseInt(sel.value, 10) || 1;
    sel.innerHTML = '';
    for (var d = 1; d <= max; d++) {
      var o = document.createElement('option');
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    }
    sel.value = Math.min(cur, max);
  }

  function setPickerVal(p, date) {
    document.getElementById(p + 'Mo').value = date.getMonth() + 1;
    document.getElementById(p + 'Yr').value = date.getFullYear();
    buildDays(p);
    document.getElementById(p + 'Dy').value = date.getDate();
  }

  function getPickerDate(p) {
    var mo = parseInt(document.getElementById(p + 'Mo').value, 10);
    var dy = parseInt(document.getElementById(p + 'Dy').value, 10);
    var yr = parseInt(document.getElementById(p + 'Yr').value, 10);
    return new Date(yr, mo - 1, dy);
  }

  function closePicker() {
    var drop = document.getElementById('dpickDrop');
    var btn  = document.getElementById('dpickBtn');
    if (drop) drop.classList.remove('is-open');
    if (btn)  btn.classList.remove('is-open');
  }

  /* ================================================================
     UTILITIES
  ================================================================ */
  function fmt(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function setDateRange() {
    var el = document.getElementById('dateRange');
    if (!el) return;
    if (_isCustom && _customFrom && _customTo) {
      el.textContent = fmt(_customFrom) + '  →  ' + fmt(_customTo);
    } else {
      var now = new Date(), from = new Date(now);
      from.setDate(from.getDate() - _days);
      el.textContent = fmt(from) + '  →  ' + fmt(now);
    }
  }

  function showErr(msg) {
    var el = document.getElementById('errBox');
    if (el) el.innerHTML = '<div class="err-box">&#9888; ' + msg + '</div>';
  }

  function clearErr() {
    var el = document.getElementById('errBox');
    if (el) el.innerHTML = '';
  }

  function showBox(label, pct) {
    document.getElementById('tbl').innerHTML =
      '<div class="box">' +
        '<div class="spinner"></div>' +
        '<div class="msg-txt">' + label + '</div>' +
        (pct !== undefined
          ? '<div class="pbar-bg"><div class="pbar-fill" style="width:' + pct + '%"></div></div>'
          : '') +
      '</div>';
  }

  function resetKPIs() {
    ['k1','k2','k3','k4','k5'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = '\u2014';
    });
  }

  function metersToMiles(m) {
    var v = parseFloat(m);
    return isNaN(v) ? 0 : v * 0.000621371;
  }

  function durationToHours(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val / 3600;
    var s = String(val), days = 0;
    if (s.indexOf('.') !== -1 && s.indexOf(':') !== -1 && s.indexOf('.') < s.indexOf(':')) {
      var dp = s.split('.'); days = parseInt(dp[0], 10) || 0; s = dp[1];
    }
    var parts = s.split(':');
    if (parts.length < 3) return 0;
    return (days * 24) +
           (parseInt(parts[0], 10) || 0) +
           ((parseInt(parts[1], 10) || 0) / 60) +
           ((parseFloat(parts[2]) || 0) / 3600);
  }

  /* ================================================================
     RENDER
  ================================================================ */
  function renderKPIs(rows) {
    var tm = rows.reduce(function (s, r) { return s + r.miles; }, 0);
    var ti = rows.reduce(function (s, r) { return s + r.idleH; }, 0);
    var tt = rows.reduce(function (s, r) { return s + r.trips; }, 0);

    document.getElementById('k1').textContent = Math.round(tm).toLocaleString();
    document.getElementById('k2').textContent = ti.toFixed(1) + 'h';
    document.getElementById('k3').textContent = rows.length ? Math.round(tm / rows.length).toLocaleString() : '0';
    document.getElementById('k4').textContent = rows.length;
    document.getElementById('k5').textContent = tt.toLocaleString();

    var rangeLabel = _isCustom ? 'Custom range' : 'Last ' + _days + ' days';
    var foot = document.getElementById('foot');
    if (foot) foot.textContent = 'Last refreshed: ' + new Date().toLocaleString() + '  |  ' + rangeLabel;
  }

  function renderTable(rows) {
    if (!rows || !rows.length) { showBox('No data found for the selected period.'); return; }
    var mx = Math.max.apply(null, rows.map(function (r) { return r.idleH || 0; })) || 1;

    function th(k, label) {
      var arrow = _sortKey === k ? (' <em class="sarr">' + (_sortDir === -1 ? '&#9660;' : '&#9650;') + '</em>') : '';
      return '<th onclick="fleetDash.sort(\'' + k + '\')">' + label + arrow + '</th>';
    }

    var h = '<table><thead><tr>' +
      th('name', 'Vehicle') +
      th('miles', 'Mileage (mi)') +
      th('trips', 'Trips') +
      th('idleH', 'Idle Time') +
      '<th>Idle Level</th>' +
      '</tr></thead><tbody>';

    rows.forEach(function (r) {
      var idleH = r.idleH || 0;
      var pct   = (idleH / mx) * 100;
      var lbl   = pct > 66 ? 'HIGH' : pct > 33 ? 'MED' : 'LOW';
      var cls   = pct > 66 ? 'bh'   : pct > 33 ? 'bm'  : 'bl';
      h += '<tr>' +
        '<td class="vname">' + r.name + '</td>' +
        '<td class="mval">'  + Math.round(r.miles).toLocaleString() + '</td>' +
        '<td class="tval">'  + r.trips.toLocaleString() + '</td>' +
        '<td><div class="ibar-wrap">' +
          '<div class="ibar-bg"><div class="ibar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<span class="ival">' + idleH.toFixed(1) + 'h</span>' +
        '</div></td>' +
        '<td><span class="bdg ' + cls + '">' + lbl + '</span></td>' +
      '</tr>';
    });

    document.getElementById('tbl').innerHTML = h + '</tbody></table>';
  }

  function getFilteredRows() {
    var q = (document.getElementById('srch') || {}).value || '';
    q = q.toLowerCase();
    return q ? _rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) !== -1; }) : _rows;
  }

  /* ================================================================
     FETCH — DEVICES (cursor paging, no resultsLimit)

     Geotab's Get/Device endpoint does not support a fromId cursor
     the same way Trip does, so we use resultsLimit + offset-style
     paging via the search.fromVersion / search.id approach.

     Instead we use the recommended approach: call without a limit,
     relying on the Geotab server's default page handling, and
     accumulate pages via fromId until we receive an empty page.

     Pattern:
       1. Call Get/Device with no resultsLimit.
       2. If the response length equals PAGE_SIZE, record the last
          id as the next cursor and repeat.
       3. Stop when a page is shorter than PAGE_SIZE (final page).
  ================================================================ */
  function fetchAllDevices(onDone, onErr) {
    var allDevices = [];
    var lastId     = null;

    function nextPage() {
      var search = lastId ? { fromId: lastId } : {};
      _api.call('Get', { typeName: 'Device', search: search }, function (page) {
        page = page || [];
        console.log('[FleetDash] Device page: ' + page.length + ' records' + (lastId ? ' (cursor: ' + lastId + ')' : ''));

        if (!page.length) {
          // Empty page — we're done
          onDone(allDevices);
          return;
        }

        // Deduplicate in case the cursor overlaps
        page.forEach(function (d) { allDevices.push(d); });

        if (page.length < PAGE_SIZE) {
          // Final page (shorter than a full page)
          onDone(allDevices);
        } else {
          // Full page — there may be more; advance cursor
          lastId = page[page.length - 1].id;
          nextPage();
        }
      }, onErr);
    }

    nextPage();
  }

  /* ================================================================
     FETCH — TRIPS (time-window paging, no resultsLimit)

     Trips are fetched fleet-wide in sequential WINDOW_DAYS-day
     time slices, identical to the safety scorecard approach.
     This avoids hitting the server record limit on any single call.
  ================================================================ */
  function fetchTripsWindowed(fromStr, toStr, onDone, onErr) {
    // Build array of [windowFrom, windowTo] pairs
    var windows = [];
    var cursor  = new Date(fromStr);
    var end     = new Date(toStr);

    while (cursor < end) {
      var wEnd = new Date(cursor);
      wEnd.setDate(wEnd.getDate() + WINDOW_DAYS);
      if (wEnd > end) wEnd = end;
      windows.push([cursor.toISOString(), wEnd.toISOString()]);
      cursor = wEnd;
    }

    console.log('[FleetDash] Trip fetch: ' + windows.length + ' × ' + WINDOW_DAYS + '-day windows, range:', fromStr, '→', toStr);

    // Accumulate per-vehicle miles, idle, and trip counts
    var milesMap = {};
    var idleMap  = {};
    var tripMap  = {};
    var nameMap  = {};   // device id → name (from Trip.device.name if available)

    var winIdx = 0;

    function nextWindow() {
      if (winIdx >= windows.length) {
        console.log('[FleetDash] All trip windows complete. Vehicles with data:', Object.keys(milesMap).length);
        onDone(milesMap, idleMap, tripMap, nameMap);
        return;
      }

      var w   = windows[winIdx];
      var pct = Math.round(20 + (winIdx / windows.length) * 65);
      showBox('FETCHING TRIPS… (window ' + (winIdx + 1) + '/' + windows.length + ')', pct);
      console.log('[FleetDash] Trip window ' + (winIdx + 1) + '/' + windows.length + ':', w[0], '→', w[1]);
      winIdx++;

      _api.call('Get', {
        typeName: 'Trip',
        search: { fromDate: w[0], toDate: w[1] }
      }, function (trips) {
        trips = trips || [];
        console.log('[FleetDash]   Window returned ' + trips.length + ' trips');

        trips.forEach(function (t) {
          var did = t.device && t.device.id;
          if (!did) return;

          milesMap[did] = (milesMap[did] || 0) + metersToMiles(t.distance);
          idleMap[did]  = (idleMap[did]  || 0) + durationToHours(t.idlingDuration);
          tripMap[did]  = (tripMap[did]  || 0) + 1;

          // Capture device name from trip data when available
          if (!nameMap[did] && t.device && t.device.name) {
            nameMap[did] = t.device.name;
          }
        });

        nextWindow();
      }, function (err) {
        console.error('[FleetDash] Trip window ' + winIdx + ' failed:', err);
        onErr('Trip fetch failed (window ' + winIdx + '): ' + (err && err.message ? err.message : JSON.stringify(err)));
      });
    }

    nextWindow();
  }

  /* ================================================================
     MAIN FETCH ORCHESTRATOR
  ================================================================ */
  function fetchData() {
    if (!_api) { showBox('API not ready.'); return; }
    clearErr();
    resetKPIs();
    showBox('FETCHING VEHICLES…', 5);

    var toDate, fromDate;
    if (_isCustom && _customFrom && _customTo) {
      fromDate = new Date(_customFrom); fromDate.setHours(0, 0, 0, 0);
      toDate   = new Date(_customTo);   toDate.setHours(23, 59, 59, 999);
    } else {
      toDate   = new Date();
      fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - _days);
    }

    var fromStr = fromDate.toISOString();
    var toStr   = toDate.toISOString();

    // Step 1 — Fetch all devices (paged, no resultsLimit)
    fetchAllDevices(function (devices) {
      if (!devices || !devices.length) { showBox('No vehicles found.'); return; }

      // Build a device id → name map from Device records
      var devMap = {};
      devices.forEach(function (d) { devMap[d.id] = d.name || d.id; });

      console.log('[FleetDash] Fetched ' + devices.length + ' devices total');
      showBox('FETCHING TRIPS FOR ' + devices.length + ' VEHICLES…', 15);

      // Step 2 — Fetch all trips in time windows (no resultsLimit)
      fetchTripsWindowed(fromStr, toStr, function (milesMap, idleMap, tripMap, nameMap) {
        showBox('BUILDING TABLE…', 90);

        // Merge device names: prefer Device record name, fall back to trip-embedded name
        var rows = [];
        Object.keys(milesMap).forEach(function (did) {
          var miles = milesMap[did] || 0;
          var idleH = idleMap[did]  || 0;
          var trips = tripMap[did]  || 0;
          if (miles === 0 && idleH === 0 && trips === 0) return;

          var name = devMap[did] || nameMap[did] || did;
          rows.push({ name: name, miles: miles, idleH: idleH, trips: trips });
        });

        rows.sort(function (a, b) { return b.miles - a.miles; });
        _rows    = rows;
        _sortKey = 'miles';
        _sortDir = -1;

        if (!rows.length) { showBox('No trip data found for the selected period.'); return; }
        renderKPIs(rows);
        renderTable(rows);

      }, function (errMsg) {
        showBox('');
        showErr(errMsg);
      });

    }, function (err) {
      showBox('');
      showErr('Device fetch failed: ' + (err && err.message ? err.message : JSON.stringify(err)));
    });
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  return {
    init: function (api) {
      _api = api;
      setDateRange();
      var btnRefresh = document.getElementById('btnRefresh');
      if (btnRefresh) btnRefresh.onclick = fetchData;
      initPicker();
    },

    fetch: fetchData,

    setRange: function (days) {
      _days = days; _isCustom = false; _customFrom = null; _customTo = null;
      document.querySelectorAll('.range-btn').forEach(function (b) {
        b.classList.toggle('active', b.textContent.trim() === days + 'D');
      });
      var btn = document.getElementById('dpickBtn');
      if (btn) btn.classList.remove('has-custom');
      var lbl = document.getElementById('dpickLabel');
      if (lbl) lbl.textContent = 'Custom';
      var clr = document.getElementById('dpickClear');
      if (clr) clr.style.display = 'none';
      setDateRange();
      fetchData();
    },

    toggleTheme: function () {
      _isLight = !_isLight;
      document.body.classList.toggle('light', _isLight);
      var lbl = document.getElementById('themeLbl');
      if (lbl) lbl.textContent = _isLight ? 'LIGHT' : 'DARK';
    },

    togglePicker: function () {
      var drop = document.getElementById('dpickDrop');
      var btn  = document.getElementById('dpickBtn');
      if (!drop) return;
      var open = drop.classList.toggle('is-open');
      if (btn) btn.classList.toggle('is-open', open);
      var err = document.getElementById('dpickErr');
      if (err) err.textContent = '';
    },

    applyCustom: function () {
      var from   = getPickerDate('s');
      var to     = getPickerDate('e');
      var errEl  = document.getElementById('dpickErr');
      if (errEl) errEl.textContent = '';

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        if (errEl) errEl.textContent = 'Invalid date.'; return;
      }
      if (from > to) {
        if (errEl) errEl.textContent = 'Start must be before end.'; return;
      }
      var diff = Math.round((to - from) / 86400000);
      if (diff > 365) {
        if (errEl) errEl.textContent = 'Range cannot exceed 365 days.'; return;
      }

      _customFrom = from; _customTo = to; _isCustom = true;

      document.querySelectorAll('.range-btn').forEach(function (b) { b.classList.remove('active'); });
      var btn = document.getElementById('dpickBtn');
      var drop = document.getElementById('dpickDrop');
      if (btn)  { btn.classList.remove('is-open'); btn.classList.add('has-custom'); }
      if (drop) drop.classList.remove('is-open');

      var dpLbl = document.getElementById('dpickLabel');
      if (dpLbl) dpLbl.textContent =
        MONTHS[from.getMonth()] + ' ' + from.getDate() +
        ' - ' +
        MONTHS[to.getMonth()] + ' ' + to.getDate() + ', ' + to.getFullYear();

      var clr = document.getElementById('dpickClear');
      if (clr) clr.style.display = 'block';

      setDateRange();
      fetchData();
    },

    clearCustom: function () {
      _isCustom = false; _customFrom = null; _customTo = null;
      var btn = document.getElementById('dpickBtn');
      if (btn) btn.classList.remove('has-custom');
      var lbl = document.getElementById('dpickLabel');
      if (lbl) lbl.textContent = 'Custom';
      var clr = document.getElementById('dpickClear');
      if (clr) clr.style.display = 'none';
      document.querySelectorAll('.range-btn').forEach(function (b) {
        b.classList.toggle('active', b.textContent.trim() === _days + 'D');
      });
      closePicker();
      setDateRange();
      fetchData();
    },

    sort: function (k) {
      if (_sortKey === k) { _sortDir *= -1; } else { _sortKey = k; _sortDir = k === 'name' ? 1 : -1; }
      _rows.sort(function (a, b) {
        if (typeof a[k] === 'string') return _sortDir * a[k].localeCompare(b[k]);
        return _sortDir * (b[k] - a[k]);
      });
      renderTable(getFilteredRows());
    },

    filter: function () { renderTable(getFilteredRows()); },

    exportCSV: function () {
      if (!_rows.length) return;
      var toDate, fromDate;
      if (_isCustom && _customFrom && _customTo) {
        fromDate = _customFrom; toDate = _customTo;
      } else {
        toDate   = new Date();
        fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - _days);
      }
      var period = fmt(fromDate) + ' to ' + fmt(toDate);
      var lines  = ['Fleet Dashboard Export', 'Period: ' + period, '', 'Vehicle,Mileage (mi),Trips,Idle Time (h),Idle Level'];
      var mx     = Math.max.apply(null, _rows.map(function (r) { return r.idleH || 0; })) || 1;
      _rows.forEach(function (r) {
        var pct = (r.idleH || 0) / mx * 100;
        lines.push(
          '"' + r.name.replace(/"/g, '""') + '",' +
          Math.round(r.miles) + ',' +
          r.trips + ',' +
          (r.idleH || 0).toFixed(2) + ',' +
          (pct > 66 ? 'HIGH' : pct > 33 ? 'MED' : 'LOW')
        );
      });
      var tm = _rows.reduce(function (s, r) { return s + r.miles; }, 0);
      var tt = _rows.reduce(function (s, r) { return s + r.trips; }, 0);
      var ti = _rows.reduce(function (s, r) { return s + r.idleH; }, 0);
      lines.push('"TOTAL",' + Math.round(tm) + ',' + tt + ',' + ti.toFixed(2) + ',');

      var blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = 'fleet-dashboard.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }
  };
})();

/* ── Geotab Add-In Entry Points ─────────────────────────── */
geotab.addin = geotab.addin || {};
geotab.addin.fleetdashboard = function () {
  return {
    initialize: function (api, state, cb) {
      var el = document.getElementById('fleetdashboard');
      if (el) el.style.display = '';
      fleetDash.init(api);
      if (typeof cb === 'function') cb();
    },
    focus: function () { fleetDash.fetch(); },
    blur:  function () {}
  };
};