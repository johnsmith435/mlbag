#!/usr/bin/env python3
"""
BaseballNow dev server
  - Serves static files (index.html, styles.css, main.js)
  - Proxies Baseball Savant percentile CSV data with 6-hour cache

Usage:
    python3 server.py
    open http://localhost:8080
"""

import csv
import http.server
import io
import json
import os
import socketserver
import time
import urllib.error
import urllib.parse
import urllib.request

PORT     = int(os.environ.get('PORT', 8080))
TTL      = 6 * 3600   # cache percentile data for 6 hours

# { "batter_2026": (fetched_at, {player_id: {col: val, ...}}) }
_cache: dict = {}

# FanGraphs WAR cache: { "batter_2026": (fetched_at, {mlbam_id: war}) }
_fg_cache: dict = {}

# Full historical WAR cache: { "batter": (fetched_at, {player_id: {year: war}}) }
_war_full_cache: dict = {}

# Expected-statistics cache: { "batter_2026": (fetched_at, {player_id: {key: float}}) }
_ev_cache: dict = {}

# Custom-leaderboard cache: actual Statcast values (whiff%, chase%, EV, etc.)
_cv_cache: dict = {}

# Map expected_statistics CSV columns → friendly JS-facing keys (actual values, not percentiles)
_EV_COL_MAP = {
    # batters
    'est_ba':   'xba_val',
    'est_slg':  'xslg_val',
    'est_woba': 'xwoba_val',
    # pitchers (also uses est_ba/est_woba for opponent stats, plus xera)
    'xera':     'xera_val',
}

# Map custom-leaderboard CSV columns → JS-facing actual-value keys
_CV_COL_MAP = {
    'k_percent':          'k_pct_val',
    'bb_percent':         'bb_pct_val',
    'whiff_percent':      'whiff_val',
    'chase_percent':      'chase_val',
    'exit_velocity':      'ev_val',
    'hard_hit_percent':   'hard_hit_val',
    'barrel_batted_rate': 'barrel_val',
    'sprint_speed':       'sprint_val',
    'bat_speed':          'bat_speed_val',
    'fb_velocity':        'fb_velo_val',
}

# Savant uses inconsistent ID column names across years — try all of them.
_ID_COLS = ('player_id', 'xba_id', 'mlbam_id', 'id')

# Map Savant CSV column names → friendly JS-facing keys.
# Values in the CSV are already percentile ranks (0-100).
_COL_MAP = {
    'xwoba':           'xwoba',
    'xba':             'xba',
    'xslg':            'xslg',
    'exit_velocity':   'ev',
    'brl_percent':     'barrel',
    'hard_hit_percent':'hard_hit',
    'k_percent':       'k_pct',
    'bb_percent':      'bb_pct',
    'whiff_percent':   'whiff',
    'chase_percent':   'chase',
    'sprint_speed':    'sprint',
    'arm_strength':    'arm',
    'bat_speed':       'bat_speed',
    # pitcher-specific
    'era':             'era',
    'xera':            'xera',
    'fb_velocity':     'fb_velo',
    'fb_spin':         'fb_spin',
}


def _fetch_percentiles(player_type: str, year: int) -> dict:
    """Fetch + parse Savant percentile CSV; return dict keyed by player_id string."""
    cache_key = f'{player_type}_{year}'
    now = time.time()

    if cache_key in _cache:
        fetched_at, data = _cache[cache_key]
        if now - fetched_at < TTL:
            return data

    url = (
        f'https://baseballsavant.mlb.com/leaderboard/percentile-rankings'
        f'?type={player_type}&year={year}&csv=true'
    )
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://baseballsavant.mlb.com/',
    })

    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode('utf-8-sig')   # strip BOM if present

    reader = csv.DictReader(io.StringIO(raw))
    # Normalise column names to lowercase, strip whitespace
    reader.fieldnames = [f.strip().lower() for f in (reader.fieldnames or [])]

    result: dict = {}
    for row in reader:
        # Find player ID from whichever column Savant uses this year
        pid = next((row[c].strip() for c in _ID_COLS if c in row and row[c].strip()), None)
        if not pid:
            continue

        # Extract only the mapped percentile columns (drop raw stat noise)
        pcts: dict = {}
        for col, key in _COL_MAP.items():
            if col in row and row[col].strip():
                try:
                    pcts[key] = round(float(row[col]))
                except ValueError:
                    pass

        # Store name for debugging (CSV uses "Last, First" in player_name)
        pcts['name'] = row.get('player_name', '').strip()
        result[pid] = pcts

    _cache[cache_key] = (now, result)
    print(f'  [savant] cached {len(result)} {player_type} percentile rows for {year}')
    return result


# League-average OBP / SLG / ERA by season (for OPS+ / ERA+ approximation).
# Sourced from public baseball-reference league history tables.
# Current season uses MLB Stats API; historical seasons use this table.
_LG_AVG = {
    # season: (lgOBP, lgSLG, lgERA)
    2026: (.316, .400, 4.10), 2025: (.313, .396, 4.06), 2024: (.315, .399, 4.02),
    2023: (.320, .414, 4.33), 2022: (.304, .389, 3.97), 2021: (.320, .411, 4.26),
    2020: (.322, .413, 4.44), 2019: (.323, .435, 4.49), 2018: (.318, .409, 4.15),
    2017: (.325, .426, 4.36), 2016: (.322, .417, 4.18), 2015: (.317, .405, 4.02),
    2014: (.314, .386, 3.74), 2013: (.318, .396, 3.87), 2012: (.320, .405, 4.01),
    2011: (.321, .399, 3.94), 2010: (.325, .403, 4.08), 2009: (.333, .418, 4.32),
    2008: (.332, .416, 4.32), 2007: (.334, .423, 4.47), 2006: (.337, .432, 4.53),
    2005: (.330, .419, 4.34), 2004: (.333, .428, 4.46), 2003: (.332, .422, 4.38),
    2002: (.331, .413, 4.15), 2001: (.331, .425, 4.36), 2000: (.345, .437, 4.77),
    1999: (.345, .436, 4.71), 1998: (.337, .421, 4.47), 1997: (.340, .424, 4.21),
    1996: (.341, .432, 4.58), 1995: (.338, .420, 4.47), 1994: (.340, .432, 4.52),
    1993: (.337, .413, 4.17), 1992: (.322, .376, 3.88), 1991: (.325, .378, 3.93),
    1990: (.324, .373, 3.79), 1989: (.321, .368, 3.80), 1988: (.319, .363, 3.72),
    1987: (.330, .405, 4.25), 1986: (.326, .385, 4.01), 1985: (.325, .380, 3.99),
    1984: (.323, .376, 3.91), 1983: (.325, .381, 3.98), 1982: (.325, .382, 3.96),
    1981: (.319, .369, 3.71), 1980: (.326, .381, 3.99), 1979: (.327, .388, 3.94),
    1978: (.320, .370, 3.59), 1977: (.325, .393, 3.91), 1976: (.314, .356, 3.52),
    1975: (.327, .370, 3.76), 1974: (.321, .361, 3.62), 1973: (.327, .381, 3.82),
    1972: (.314, .340, 3.45), 1971: (.320, .356, 3.47), 1970: (.328, .389, 3.71),
    1969: (.325, .369, 3.59), 1968: (.299, .341, 2.98), 1967: (.308, .351, 3.23),
    1966: (.311, .373, 3.61), 1965: (.311, .369, 3.54), 1964: (.315, .378, 3.54),
    1963: (.308, .363, 3.29), 1962: (.325, .393, 3.97), 1961: (.325, .388, 3.95),
    1960: (.323, .378, 3.87), 1959: (.321, .381, 3.93), 1958: (.323, .378, 3.95),
}
_LG_DEFAULT = (.323, .400, 4.00)  # fallback for seasons not in table

def _fetch_expected_vals(player_type: str, year: int) -> dict:
    """Fetch actual xERA / xBA / xSLG / xwOBA values from expected_statistics leaderboard."""
    cache_key = f'ev_{player_type}_{year}'
    now = time.time()
    if cache_key in _ev_cache:
        fetched_at, data = _ev_cache[cache_key]
        if now - fetched_at < TTL:
            return data

    url = (f'https://baseballsavant.mlb.com/leaderboard/expected_statistics'
           f'?type={player_type}&year={year}&min=50&csv=true')
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://baseballsavant.mlb.com/',
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode('utf-8-sig')

    reader = csv.DictReader(io.StringIO(raw))
    reader.fieldnames = [f.strip().lower() for f in (reader.fieldnames or [])]

    result: dict = {}
    for row in reader:
        pid = next((row[c].strip() for c in _ID_COLS if c in row and row[c].strip()), None)
        if not pid:
            continue
        vals: dict = {}
        for col, key in _EV_COL_MAP.items():
            if col in row and row[col].strip():
                try:
                    vals[key] = float(row[col])
                except ValueError:
                    pass
        result[pid] = vals

    _ev_cache[cache_key] = (now, result)
    print(f'  [savant-ev] cached {len(result)} {player_type} expected-stat rows for {year}')
    return result


def _fetch_custom_vals(player_type: str, year: int) -> dict:
    """Fetch actual Statcast values (whiff%, chase%, EV, barrel%, etc.) from custom leaderboard."""
    cache_key = f'cv_{player_type}_{year}'
    now = time.time()
    if cache_key in _cv_cache:
        fetched_at, data = _cv_cache[cache_key]
        if now - fetched_at < TTL:
            return data

    selections = 'k_percent,bb_percent,whiff_percent,chase_percent,exit_velocity,hard_hit_percent,barrel_batted_rate,sprint_speed,bat_speed,fb_velocity'
    url = (f'https://baseballsavant.mlb.com/leaderboard/custom'
           f'?year={year}&type={player_type}&filter=&min=1&selections={selections}&csv=true')
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Referer': 'https://baseballsavant.mlb.com/',
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode('utf-8-sig')

    reader = csv.DictReader(io.StringIO(raw))
    reader.fieldnames = [f.strip().lower() for f in (reader.fieldnames or [])]

    result: dict = {}
    for row in reader:
        pid = next((row[c].strip() for c in _ID_COLS if c in row and row[c].strip()), None)
        if not pid:
            continue
        vals: dict = {}
        for col, key in _CV_COL_MAP.items():
            if col in row and row[col].strip():
                try:
                    vals[key] = float(row[col])
                except ValueError:
                    pass
        result[pid] = vals

    _cv_cache[cache_key] = (now, result)
    print(f'  [savant-cv] cached {len(result)} {player_type} custom-leaderboard rows for {year}')
    return result


def _fetch_br_war_full(player_type: str) -> dict:
    """Fetch full BR WAR file (all seasons) and return dict {player_id: {year: war}}."""
    cache_key = player_type
    now = time.time()
    if cache_key in _war_full_cache:
        fetched_at, data = _war_full_cache[cache_key]
        if now - fetched_at < TTL:
            return data

    fname = 'war_daily_bat.txt' if player_type == 'batter' else 'war_daily_pitch.txt'
    url = f'https://www.baseball-reference.com/data/{fname}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/plain,*/*',
        'Referer': 'https://www.baseball-reference.com/',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode('utf-8-sig')

    reader = csv.DictReader(io.StringIO(raw))
    result: dict = {}
    for row in reader:
        mlb_id = row.get('mlb_ID', '').strip()
        year_str = row.get('year_ID', '').strip()
        war_raw = row.get('WAR', '').strip()
        if not mlb_id or not year_str or not war_raw or war_raw in ('NULL', ''):
            continue
        try:
            key = str(int(float(mlb_id)))
            war_val = float(war_raw)
            if key not in result:
                result[key] = {}
            result[key][year_str] = round((result[key].get(year_str, 0.0) + war_val), 1)
        except (ValueError, TypeError):
            pass

    _war_full_cache[cache_key] = (now, result)
    print(f'  [br-war-full] cached {len(result)} {player_type} players (all years)')
    return result


def _fetch_br_war(player_type: str, year: int) -> dict:
    """Fetch Baseball Reference daily WAR file; return dict keyed by MLBAM ID string.

    BR publishes two public flat files (no API key needed, no Cloudflare block):
      https://www.baseball-reference.com/data/war_daily_bat.txt  (batters)
      https://www.baseball-reference.com/data/war_daily_pitch.txt (pitchers)

    Both have columns: mlb_ID, year_ID, WAR — we sum WAR by mlb_ID for the
    requested year (handles mid-season trades where one player has multiple rows).
    """
    cache_key = f'br_{player_type}_{year}'
    now = time.time()
    if cache_key in _fg_cache:
        fetched_at, data = _fg_cache[cache_key]
        if now - fetched_at < TTL:
            return data

    fname = 'war_daily_bat.txt' if player_type == 'batter' else 'war_daily_pitch.txt'
    url = f'https://www.baseball-reference.com/data/{fname}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/plain,*/*',
        'Referer': 'https://www.baseball-reference.com/',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode('utf-8-sig')

    reader = csv.DictReader(io.StringIO(raw))
    result: dict = {}
    yr_str = str(year)
    for row in reader:
        if row.get('year_ID', '').strip() != yr_str:
            continue
        mlb_id = row.get('mlb_ID', '').strip()
        war_raw = row.get('WAR', '').strip()
        if not mlb_id or not war_raw or war_raw in ('NULL', ''):
            continue
        try:
            war_val = float(war_raw)
            key = str(int(float(mlb_id)))
            result[key] = round((result.get(key, 0.0) + war_val), 1)
        except (ValueError, TypeError):
            pass

    _fg_cache[cache_key] = (now, result)
    print(f'  [br-war] cached {len(result)} {player_type} WAR rows for {year}')
    return result


def _league_avg(season: int) -> tuple:
    return _LG_AVG.get(season, _LG_DEFAULT)


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/proxy/savant'):
            self._handle_savant()
        elif self.path.startswith('/proxy/war-history'):
            self._handle_war_history()
        elif self.path.startswith('/proxy/fangraphs'):
            self._handle_fangraphs()
        elif self.path.startswith('/proxy/league-avg'):
            self._handle_league_avg()
        elif self.path.startswith('/proxy/scorecard-image'):
            self._handle_scorecard_image()
        elif self.path.startswith('/proxy/scorecard'):
            self._handle_scorecard()
        elif self.path.startswith('/proxy/news'):
            self._handle_news()
        elif self.path.startswith('/proxy/logo'):
            self._handle_logo()
        else:
            super().do_GET()

    def _handle_war_history(self):
        parsed  = urllib.parse.urlparse(self.path)
        params  = urllib.parse.parse_qs(parsed.query)
        player_type = params.get('type', ['batter'])[0]
        player_id   = params.get('id', [None])[0]
        if not player_id or player_type not in ('batter', 'pitcher'):
            self._json_error(400, 'type and id required'); return
        try:
            data = _fetch_br_war_full(player_type)
            self._json_ok(data.get(str(player_id), {}))
        except Exception as e:
            self._json_error(502, str(e))

    def _handle_fangraphs(self):
        parsed  = urllib.parse.urlparse(self.path)
        params  = urllib.parse.parse_qs(parsed.query)
        player_type = params.get('type', ['batter'])[0]
        year        = int(params.get('year', [time.gmtime().tm_year])[0])
        player_id   = params.get('id', [None])[0]
        if player_type not in ('batter', 'pitcher'):
            self._json_error(400, 'type must be batter or pitcher'); return
        try:
            data = _fetch_br_war(player_type, year)
        except Exception as e:
            self._json_error(502, str(e)); return
        if player_id:
            war = data.get(str(player_id))
            self._json_ok({'war': war} if war is not None else {})
        else:
            self._json_ok(data)

    def _handle_league_avg(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        season = int(params.get('season', [time.gmtime().tm_year])[0])
        obp, slg, era = _league_avg(season)
        self._json_ok({'season': season, 'lgOBP': obp, 'lgSLG': slg, 'lgERA': era})

    def _handle_savant(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        player_type = params.get('type', ['batter'])[0]
        year        = int(params.get('year', [time.gmtime().tm_year])[0])
        player_id   = params.get('id',   [None])[0]

        if player_type not in ('batter', 'pitcher'):
            self._json_error(400, 'type must be batter or pitcher')
            return

        try:
            data = _fetch_percentiles(player_type, year)
        except urllib.error.HTTPError as e:
            self._json_error(502, f'Savant returned HTTP {e.code}')
            return
        except Exception as e:
            self._json_error(502, str(e))
            return

        if player_id:
            payload = dict(data.get(str(player_id), {}))
        else:
            payload = data

        # Merge actual stat values (xERA, xBA etc.) into the percentile payload
        try:
            ev_data = _fetch_expected_vals(player_type, year)
            if player_id:
                payload.update(ev_data.get(str(player_id), {}))
            elif isinstance(payload, dict):
                for pid, row in ev_data.items():
                    if pid in payload:
                        payload[pid].update(row)
        except Exception:
            pass  # actual values are optional; percentile data still renders

        # Merge custom-leaderboard actual values (whiff%, chase%, EV, barrel%, etc.)
        try:
            cv_data = _fetch_custom_vals(player_type, year)
            if player_id:
                payload.update(cv_data.get(str(player_id), {}))
            elif isinstance(payload, dict):
                for pid, row in cv_data.items():
                    if pid in payload:
                        payload[pid].update(row)
        except Exception:
            pass

        self._json_ok(payload)

    def _handle_scorecard_image(self):
        """Fetch livebaseballscorecards.com game page, extract og:image URL, return as JSON."""
        import ssl, re as _re
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        game_pk = params.get('gamePk', [''])[0]
        if not game_pk:
            self._json_error(400, 'gamePk required'); return

        ctx = ssl.create_default_context()
        url = f'https://livebaseballscorecards.com/game/{game_pk}'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                              'AppleWebKit/537.36 (KHTML, like Gecko) '
                              'Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,*/*',
            })
            with urllib.request.urlopen(req, context=ctx, timeout=12) as resp:
                html = resp.read().decode('utf-8', errors='replace')

            # Extract og:image content attribute
            m = _re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html)
            if not m:
                m = _re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html)

            if m:
                self._json_ok({'imageUrl': m.group(1)})
            else:
                self._json_ok({'imageUrl': None})
        except Exception as e:
            self._json_ok({'imageUrl': None, 'error': str(e)})

    def _handle_scorecard(self):
        import ssl
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        game_pk = params.get('gamePk', [''])[0]
        date    = params.get('date', [''])[0]
        away    = params.get('away', [''])[0]
        home    = params.get('home', [''])[0]

        # Build candidate URLs to try (gamePk is most reliable)
        candidates = []
        if game_pk:
            candidates.append(f'https://livebaseballscorecards.com/game/{game_pk}')
        if date and away and home:
            candidates.append(f'https://livebaseballscorecards.com/game/{date}/{away}-vs-{home}')
            candidates.append(f'https://livebaseballscorecards.com/game/{date}/{away.upper()}-{home.upper()}')

        ctx = ssl.create_default_context()
        last_err = 'No URL candidates'
        for url in candidates:
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                                  'AppleWebKit/537.36 (KHTML, like Gecko) '
                                  'Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,*/*',
                    'Referer': 'https://livebaseballscorecards.com/',
                })
                with urllib.request.urlopen(req, context=ctx, timeout=12) as resp:
                    content = resp.read()
                    html = content.decode('utf-8', errors='replace')
                    # Inject base tag so relative assets resolve correctly
                    html = html.replace('<head>', '<head><base href="https://livebaseballscorecards.com/">', 1)
                    body = html.encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.send_header('Access-Control-Allow-Origin', '*')
                    # Intentionally omit X-Frame-Options to allow iframe embedding
                    self.end_headers()
                    self.wfile.write(body)
                    return
            except Exception as e:
                last_err = str(e)

        # All attempts failed — return a helpful fallback page
        fallback = f'''<!DOCTYPE html><html><head>
<base href="https://livebaseballscorecards.com/">
<style>body{{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#aaa;text-align:center}}</style>
</head><body>
<div><p style="font-size:1rem">Scorecard not yet available for this game.</p>
<p><a href="https://livebaseballscorecards.com" target="_blank" style="color:#63b3ed">View on livebaseballscorecards.com</a></p>
<p style="font-size:0.7rem;color:#555">{last_err}</p></div>
</body></html>'''.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(fallback)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(fallback)

    def _handle_news(self):
        import xml.etree.ElementTree as ET
        import html as _html
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        q = params.get('q', ['baseball'])[0]
        url = (f'https://news.google.com/rss/search'
               f'?q={urllib.parse.quote(q)}&hl=en-US&gl=US&ceid=US:en')
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                              'AppleWebKit/537.36 (KHTML, like Gecko) '
                              'Chrome/124.0.0.0 Safari/537.36',
            })
            with urllib.request.urlopen(req, timeout=8) as resp:
                content = resp.read().decode('utf-8', errors='replace')
            root = ET.fromstring(content)
            channel = root.find('channel')
            articles = []
            for item in (channel.findall('item') if channel is not None else [])[:8]:
                title_el  = item.find('title')
                link_el   = item.find('link')
                source_el = item.find('source')
                pub_el    = item.find('pubDate')
                raw_title = title_el.text or '' if title_el is not None else ''
                title = _html.unescape(raw_title)
                if ' - ' in title:
                    title = title[:title.rfind(' - ')]
                link    = link_el.text or '' if link_el is not None else ''
                source  = _html.unescape(source_el.text or '') if source_el is not None else ''
                pubdate = pub_el.text or '' if pub_el is not None else ''
                articles.append({'title': title, 'url': link, 'source': source, 'pubDate': pubdate})
            self._json_ok({'articles': articles})
        except Exception as e:
            self._json_error(502, str(e))

    def _handle_logo(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        team_id = params.get('id', [None])[0]
        if not team_id or not team_id.isdigit():
            self._json_error(400, 'id required'); return
        url = f'https://www.mlbstatic.com/team-logos/{team_id}.svg'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=8) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/svg+xml')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._json_error(502, str(e))

    def _json_ok(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code, msg):
        body = json.dumps({'error': msg}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, fmt, *args):
        # Show proxy hits; suppress noisy static-file requests
        path = args[0] if args else ''
        if '/proxy/' in path or (not path.startswith(('GET /main', 'GET /styles', 'GET /index', 'GET / '))):
            super().log_message(fmt, *args)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with ReusableTCPServer(('', PORT), Handler) as httpd:
        print(f'BaseballNow  →  http://localhost:{PORT}')
        print(f'Savant proxy →  http://localhost:{PORT}/proxy/savant?type=batter&year=2026&id=<mlbam_id>')
        print(f'Percentile data cached for {TTL//3600}h  |  Ctrl-C to stop\n')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')
