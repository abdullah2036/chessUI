/**
 * Pairing Board — Cloudflare Worker
 * Drop-in replacement for the FastAPI backend in main.py.
 *
 * Emits the same JSON shape as `asdict()` on the dataclasses in main.py, so
 * index.html's existing renderUI() / matchPairing() work untouched:
 *
 *   Player   { name, rating, fide_id, start_no, points, federation }
 *   Pairing  { board, white, black, result }        // black is ALWAYS an object
 *   Round    { tournament_id, tournament_name, round, fetched_at,
 *              total_boards, pairings }
 *   Meta     { tournament_id, tournament_name, last_update, total_players,
 *              available_rounds, fetched_at }
 *
 * Routes:
 *   OPTIONS *                                       -> CORS preflight
 *   GET /health
 *   GET /api/tournament/{tnr_or_url}
 *   GET /api/tournament/{tnr_or_url}/round/{rd}?refresh=
 *   GET /api/tournament/{tnr_or_url}/search?rd=&q=
 *   GET /raw?url=                                   -> HTML passthrough (chess-results only)
 */

const CONFIG = {
  // Who may call this Worker. Keep it tight so nobody else burns your quota.
  // Set ALLOW_ANY_ORIGIN = true for `Access-Control-Allow-Origin: *`.
  ALLOWED_ORIGINS: [
    "https://abdullah2036.github.io",
    "http://localhost:8000",
    "http://localhost:8080",
    "http://127.0.0.1:5500",
  ],
  ALLOW_ANY_ORIGIN: false,

  CACHE_SECONDS_LIVE: 12,   // round pairings
  CACHE_SECONDS_META: 120,  // tournament metadata (matches main.py)
  CACHE_SECONDS_RAW: 12,

  MAX_PROBE_ROUNDS: 15,     // matches probe_available_rounds() in main.py
  UPSTREAM_TIMEOUT_MS: 15000,
  UPSTREAM_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  MAX_BOARDS: 5000,
  BYE_NAME: "— bye —",      // main.py uses this exact string
};

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (CONFIG.ALLOW_ANY_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CONFIG.CACHE_SECONDS_LIVE}`,
      ...corsHeaders(request),
      ...extra,
    },
  });
}

/** Mirrors FastAPI's HTTPException body: {"detail": "..."} */
function fail(request, status, detail) {
  return json(request, { detail }, status, { "Cache-Control": "no-store" });
}

/* ------------------------------------------------------------------ */
/* Upstream                                                            */
/* ------------------------------------------------------------------ */

function isChessResultsHost(host) {
  host = host.toLowerCase();
  return host === "chess-results.com" || host.endsWith(".chess-results.com");
}

function extractTnr(input) {
  if (!input) return null;
  let value = String(input).trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep as-is */
  }
  const named = value.match(/tnr(\d{1,9})/i);
  if (named) return named[1];
  const digits = value.match(/\d{1,9}/);
  return digits ? digits[0] : null;
}

/** art: 1 = starting rank, 2 = round pairings. lan=1 forces English headers. */
function buildUrl(tnr, art, rd) {
  const url = new URL(`https://chess-results.com/tnr${tnr}.aspx`);
  url.searchParams.set("lan", "1");
  url.searchParams.set("art", String(art));
  if (rd != null) url.searchParams.set("rd", String(rd));
  url.searchParams.set("turdet", "YES");
  url.searchParams.set("zeilen", "99999"); // request all rows on one page
  return url.toString();
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow", // chess-results bounces to s1/s2/s3.chess-results.com
    headers: {
      "User-Agent": CONFIG.UPSTREAM_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(CONFIG.UPSTREAM_TIMEOUT_MS),
    cf: { cacheTtl: CONFIG.CACHE_SECONDS_LIVE, cacheEverything: true },
  });
  if (!response.ok) {
    const error = new Error(`chess-results.com unreachable: HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }
  return await response.text();
}

/* ------------------------------------------------------------------ */
/* Dependency-free HTML table extraction                               */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ndash: "–", mdash: "—", laquo: "«", raquo: "»", frac12: "½",
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

const clean = (text) => decodeEntities(text).replace(/\s+/g, " ").trim();

/**
 * Returns every table as rows of cell strings. chess-results nests its data
 * tables inside layout tables, so text is attributed to the innermost open
 * cell and <script> contents are ignored.
 */
function extractTables(html) {
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  const tables = [];
  const tableStack = [];
  const cellStack = [];
  let skipDepth = 0;
  let cursor = 0;
  let match;

  const pushText = (chunk) => {
    if (skipDepth > 0 || cellStack.length === 0 || !chunk) return;
    cellStack[cellStack.length - 1].text += chunk;
  };

  while ((match = TAG.exec(html)) !== null) {
    pushText(html.slice(cursor, match.index));
    cursor = TAG.lastIndex;

    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const selfClosing = (match[3] || "").trimEnd().endsWith("/");

    if (tag === "script" || tag === "style") {
      if (closing) skipDepth = Math.max(0, skipDepth - 1);
      else if (!selfClosing) skipDepth += 1;
      continue;
    }
    if (skipDepth > 0) continue;

    switch (tag) {
      case "table":
        if (closing) tableStack.pop();
        else if (!selfClosing) {
          const table = { rows: [], current: null };
          tables.push(table);
          tableStack.push(table);
        }
        break;

      case "tr": {
        const table = tableStack[tableStack.length - 1];
        if (!table) break;
        if (closing) table.current = null;
        else if (!selfClosing) {
          table.current = [];
          table.rows.push(table.current);
        }
        break;
      }

      case "td":
      case "th": {
        if (closing) {
          const cell = cellStack.pop();
          if (cell) cell.row[cell.index] = clean(cell.text);
          break;
        }
        if (selfClosing) break;
        const table = tableStack[tableStack.length - 1];
        if (!table) break;
        if (!table.current) {
          table.current = [];
          table.rows.push(table.current);
        }
        const row = table.current;
        row.push("");
        cellStack.push({ row, index: row.length - 1, text: "" });
        break;
      }

      case "br":
        pushText(" ");
        break;

      default:
        break;
    }
  }
  pushText(html.slice(cursor));
  return tables.map((table) => table.rows.filter((row) => row.length > 0));
}

/* ------------------------------------------------------------------ */
/* Field coercion (matches main.py's _to_int / _to_points)             */
/* ------------------------------------------------------------------ */

function toInt(text) {
  const match = String(text || "").match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function toPoints(text) {
  const normalized = String(text || "").replace("½", ".5").replace(",", ".");
  const match = normalized.match(/\d+(\.\d+)?|\.5/);
  if (!match) return null;
  const value = match[0];
  return parseFloat(value.startsWith(".") ? `0${value}` : value);
}

const norm = (text) => String(text || "").toLowerCase().replace(/[.\s]/g, "");

/* ------------------------------------------------------------------ */
/* Pairing parsing                                                     */
/* ------------------------------------------------------------------ */

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i += 1) {
    const cells = rows[i].map(norm);
    if (
      cells.includes("white") &&
      cells.includes("black") &&
      (cells.includes("bo") || cells.includes("board"))
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * chess-results pairing header:
 *   Bo. | No. | (flag) | White | Rtg | Pts. | Result | Pts. | (flag) | Black | Rtg | No.
 * Duplicate labels are disambiguated by position around the White/Black columns.
 */
function mapColumns(headerCells) {
  const cells = headerCells.map(norm);
  const first = (label, from = 0, to = cells.length) => {
    for (let i = from; i < to; i += 1) if (cells[i] === label) return i;
    return -1;
  };
  const last = (label, from = 0, to = cells.length) => {
    for (let i = to - 1; i >= from; i -= 1) if (cells[i] === label) return i;
    return -1;
  };
  const firstOf = (labels, from = 0, to = cells.length) => {
    for (let i = from; i < to; i += 1) if (labels.includes(cells[i])) return i;
    return -1;
  };

  const white = first("white");
  const black = first("black");
  if (white === -1 || black === -1 || black <= white) return null;

  const result = firstOf(["result", "res"], white, black);
  const ratingLabels = ["rtg", "rtgi", "elo", "rating"];

  return {
    board: firstOf(["bo", "board"]),
    whiteNo: last("no", 0, white),
    whiteName: white,
    whiteRating: firstOf(ratingLabels, white + 1, black),
    whitePoints: result !== -1 ? last("pts", white + 1, result) : -1,
    result,
    blackPoints: result !== -1 ? first("pts", result + 1, black) : -1,
    blackName: black,
    blackRating: firstOf(ratingLabels, black + 1),
    blackNo: first("no", black + 1),
    fed: firstOf(["fed", "land"]),
  };
}

const at = (row, index) => (index >= 0 && index < row.length ? row[index] : "");

function makePlayer({ name, rating, start_no, points, federation }) {
  return {
    name: name || "",
    rating: rating ?? null,
    fide_id: null, // pairing tables carry no FIDE ID; enriched from the start list
    start_no: start_no ?? null,
    points: points ?? null,
    federation: federation || null,
  };
}

function parseRoundPairings(html, tnr, rd) {
  const tables = extractTables(html);
  let best = null;

  for (const rows of tables) {
    const headerIndex = findHeaderRow(rows);
    if (headerIndex === -1) continue;
    const columns = mapColumns(rows[headerIndex]);
    if (!columns) continue;
    const dataRows = rows.slice(headerIndex + 1);
    if (!best || dataRows.length > best.dataRows.length) best = { columns, dataRows };
  }
  if (!best) return null;

  const { columns } = best;
  const pairings = [];

  for (const row of best.dataRows) {
    if (pairings.length >= CONFIG.MAX_BOARDS) break;

    const board = toInt(at(row, columns.board));
    const whiteName = clean(at(row, columns.whiteName));
    if (!board || !whiteName) continue; // spacer / sub-header row

    const blackNameRaw = clean(at(row, columns.blackName));
    const unpaired = !blackNameRaw || /^not paired$/i.test(blackNameRaw);

    let result = clean(at(row, columns.result)) || null;
    if (result === "-" || (result && /^not paired$/i.test(result))) result = null;

    pairings.push({
      board,
      white: makePlayer({
        name: whiteName,
        rating: toInt(at(row, columns.whiteRating)),
        start_no: toInt(at(row, columns.whiteNo)),
        points: toPoints(at(row, columns.whitePoints)),
        federation: clean(at(row, columns.fed)) || null,
      }),
      black: makePlayer({
        name: unpaired ? CONFIG.BYE_NAME : blackNameRaw,
        rating: unpaired ? null : toInt(at(row, columns.blackRating)),
        start_no: unpaired ? null : toInt(at(row, columns.blackNo)),
        points: unpaired ? null : toPoints(at(row, columns.blackPoints)),
        federation: null,
      }),
      result,
    });
  }

  return {
    tournament_id: tnr,
    tournament_name: parseTitle(html, tnr),
    round: rd,
    fetched_at: Date.now() / 1000,
    total_boards: pairings.length,
    pairings,
  };
}

/* ------------------------------------------------------------------ */
/* Starting rank (FIDE IDs, federations, player count)                 */
/* ------------------------------------------------------------------ */

function parseStartingRank(html) {
  const tables = extractTables(html);
  let best = null;

  for (const rows of tables) {
    if (rows.length < 2) continue;
    const header = rows[0].map(norm);
    // A real start list has a Name column but no White/Black columns.
    if (!header.includes("name") || header.includes("white")) continue;
    if (!best || rows.length > best.length) best = rows;
  }
  if (!best) return [];

  const header = best[0].map(norm);
  const idx = (...labels) => {
    for (let i = 0; i < header.length; i += 1) {
      if (labels.some((label) => header[i] === label || header[i].startsWith(label))) return i;
    }
    return -1;
  };

  const noIdx = idx("no", "snr", "nr");
  const nameIdx = idx("name", "spielername");
  const fideIdx = idx("fideid", "fide-id", "id");
  const rtgIdx = idx("rtg", "rtgi", "elo", "rating");
  const fedIdx = idx("fed", "land");

  const players = [];
  for (const row of best.slice(1)) {
    const name = clean(at(row, nameIdx));
    if (!name) continue;
    const fideRaw = clean(at(row, fideIdx));
    players.push({
      name,
      rating: rtgIdx >= 0 ? toInt(at(row, rtgIdx)) : null,
      fide_id: /^\d{4,}$/.test(fideRaw) ? fideRaw : null,
      start_no: noIdx >= 0 ? toInt(at(row, noIdx)) : null,
      points: null,
      federation: fedIdx >= 0 ? clean(at(row, fedIdx)) || null : null,
    });
  }
  return players;
}

/** Fills fide_id / federation into pairings by matching start numbers. */
function enrichWithStartList(roundData, startList) {
  if (!startList.length) return roundData;
  const byNo = new Map();
  for (const player of startList) {
    if (player.start_no != null) byNo.set(player.start_no, player);
  }
  for (const pairing of roundData.pairings) {
    for (const side of ["white", "black"]) {
      const player = pairing[side];
      const source = player.start_no != null ? byNo.get(player.start_no) : null;
      if (!source) continue;
      if (player.fide_id == null) player.fide_id = source.fide_id;
      if (player.federation == null) player.federation = source.federation;
    }
  }
  return roundData;
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

function parseTitle(html, tnr) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return `Tournament ${tnr}`;
  const text = clean(match[1])
    .replace(/^Chess-Results\s*Server\s*/i, "")
    .replace(/^chess-results\.com\s*-\s*/i, "")
    .replace(/^\d+\.\s*/, "");
  if (!text || text.toLowerCase().includes("object moved")) return `Tournament ${tnr}`;
  return text;
}

function parseLastUpdate(html) {
  const match = html.match(/Last update\s*([\d.]+\s+[\d:]+)/i);
  return match ? match[1].trim() : null;
}

/** The page states which round it is actually showing: "Round 3 on 2024/11/23". */
function parseShownRound(html) {
  const match = html.match(/Round\s+(\d{1,3})\b/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Probes rounds 1..N concurrently. Critically, chess-results serves round 1 for
 * *any* rd on archived tournaments, so a round only counts as real if the page
 * it returns says it is that round. Without this check every tournament reports
 * the full probe range as available.
 */
async function probeAvailableRounds(tnr) {
  const probe = async (rd) => {
    try {
      const html = await fetchHtml(buildUrl(tnr, 2, rd));
      const shown = parseShownRound(html);
      if (shown != null && shown !== rd) return null; // server fell back to another round
      const data = parseRoundPairings(html, tnr, rd);
      return data && data.pairings.length > 0 ? rd : null;
    } catch {
      return null;
    }
  };

  const rounds = Array.from({ length: CONFIG.MAX_PROBE_ROUNDS }, (_, i) => i + 1);
  const results = await Promise.all(rounds.map(probe));
  const valid = results.filter((rd) => rd !== null).sort((a, b) => a - b);
  return valid.length ? valid : [1];
}

/* ------------------------------------------------------------------ */
/* Search (mirrors match_player_flexible in main.py)                   */
/* ------------------------------------------------------------------ */

function normTokens(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function matchPlayerFlexible(query, roundData) {
  const raw = query.trim();
  if (!raw) return [];

  const queryTokens = normTokens(raw);
  const isNum = /^\d+$/.test(raw);
  const queryNum = isNum ? parseInt(raw, 10) : null;
  const matches = [];

  for (const pairing of roundData.pairings) {
    const boardHit = isNum && pairing.board === queryNum;

    for (const [color, me, opponent] of [
      ["white", pairing.white, pairing.black],
      ["black", pairing.black, pairing.white],
    ]) {
      if (!me.name) continue;

      const idHit = isNum && (me.start_no === queryNum || me.fide_id === raw);
      const nameTokens = normTokens(me.name);
      const nameHit =
        queryTokens.length > 0 &&
        queryTokens.every((token) => nameTokens.some((word) => word.includes(token)));

      if (boardHit || idHit || nameHit) {
        matches.push({
          board: pairing.board,
          color,
          you: me,
          opponent,
          result: pairing.result,
          match_type: boardHit ? "board" : idHit ? "id" : "name",
        });
      }
    }
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/* Edge cache                                                          */
/* ------------------------------------------------------------------ */

async function cachedJson(ctx, key, ttl, produce) {
  const cache = caches.default;
  const cacheKey = new Request(`https://pairing-cache.internal/${encodeURIComponent(key)}`);

  const hit = await cache.match(cacheKey);
  if (hit) return { body: await hit.text(), cacheStatus: "HIT" };

  const value = await produce();
  const body = JSON.stringify(value);
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${ttl}`,
        },
      })
    )
  );
  return { body, cacheStatus: "MISS" };
}

/* ------------------------------------------------------------------ */
/* Route handlers                                                      */
/* ------------------------------------------------------------------ */

async function getStartList(ctx, tnr) {
  const { body } = await cachedJson(ctx, `rank:${tnr}`, CONFIG.CACHE_SECONDS_META, async () => {
    const html = await fetchHtml(buildUrl(tnr, 1, null));
    return parseStartingRank(html);
  });
  return JSON.parse(body);
}

async function getRoundData(ctx, tnr, rd) {
  const { body, cacheStatus } = await cachedJson(
    ctx,
    `rd:${tnr}:${rd}`,
    CONFIG.CACHE_SECONDS_LIVE,
    async () => {
      const html = await fetchHtml(buildUrl(tnr, 2, rd));
      const data = parseRoundPairings(html, tnr, rd);
      if (!data) {
        const error = new Error(
          `Pairings for Round ${rd} are not published yet or tournament ID ${tnr} is invalid.`
        );
        error.status = 404;
        throw error;
      }
      try {
        enrichWithStartList(data, await getStartList(ctx, tnr));
      } catch {
        /* enrichment is best-effort */
      }
      return data;
    }
  );
  return { data: JSON.parse(body), cacheStatus };
}

async function handleMeta(request, ctx, tnr) {
  const { body, cacheStatus } = await cachedJson(
    ctx,
    `meta:${tnr}`,
    CONFIG.CACHE_SECONDS_META,
    async () => {
      const html = await fetchHtml(buildUrl(tnr, 2, 1));
      const availableRounds = await probeAvailableRounds(tnr);

      let totalPlayers = 0;
      try {
        totalPlayers = (await getStartList(ctx, tnr)).length;
      } catch {
        /* fall through to the pairing-derived estimate */
      }

      // Archived tournaments redirect the start list to the pairings page, so
      // fall back to the highest start number appearing in round 1.
      if (!totalPlayers) {
        const first = parseRoundPairings(html, tnr, 1);
        if (first) {
          for (const pairing of first.pairings) {
            for (const side of ["white", "black"]) {
              const no = pairing[side].start_no;
              if (no != null && no > totalPlayers) totalPlayers = no;
            }
          }
        }
      }

      return {
        tournament_id: tnr,
        tournament_name: parseTitle(html, tnr),
        last_update: parseLastUpdate(html),
        total_players: totalPlayers,
        available_rounds: availableRounds,
        fetched_at: Date.now() / 1000,
      };
    }
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CONFIG.CACHE_SECONDS_META}`,
      "X-Cache": cacheStatus,
      ...corsHeaders(request),
    },
  });
}

async function handleRound(request, ctx, tnr, rd) {
  const { data, cacheStatus } = await getRoundData(ctx, tnr, rd);
  return json(request, data, 200, { "X-Cache": cacheStatus });
}

async function handleSearch(request, ctx, tnr, url) {
  const query = url.searchParams.get("q") || "";
  const rd = toInt(url.searchParams.get("rd"));
  if (!rd) return fail(request, 422, "Query parameter 'rd' is required.");
  if (!query.trim()) return fail(request, 422, "Query parameter 'q' is required.");

  const { data, cacheStatus } = await getRoundData(ctx, tnr, rd);
  const matches = matchPlayerFlexible(query, data);

  return json(
    request,
    {
      tournament_id: tnr,
      tournament_name: data.tournament_name,
      round: data.round,
      query,
      total_matches: matches.length,
      matches,
    },
    200,
    { "X-Cache": cacheStatus }
  );
}

async function handleRaw(request, url) {
  const target = url.searchParams.get("url");
  if (!target) return fail(request, 400, "Missing 'url' parameter.");

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return fail(request, 400, "Malformed URL.");
  }
  if (parsed.protocol !== "https:" || !isChessResultsHost(parsed.hostname)) {
    return fail(request, 403, "Only https chess-results.com URLs may be proxied.");
  }

  const html = await fetchHtml(parsed.toString());
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, max-age=${CONFIG.CACHE_SECONDS_RAW}`,
      ...corsHeaders(request),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(request, 405, "This proxy is read-only (GET/OPTIONS only).");
    }

    try {
      if (url.pathname === "/health") {
        return json(request, { ok: true, time: Date.now() / 1000 });
      }
      if (url.pathname === "/raw") {
        return await handleRaw(request, url);
      }

      const route = url.pathname.match(
        /^\/api\/tournament\/([^/]+)(?:\/(round|search)(?:\/([^/]+))?)?\/?$/
      );
      if (route) {
        const tnr = extractTnr(route[1]);
        if (!tnr) return fail(request, 400, `Invalid tournament ID or URL: '${route[1]}'`);

        if (!route[2]) return await handleMeta(request, ctx, tnr);
        if (route[2] === "round") {
          const rd = toInt(route[3]);
          if (!rd) return fail(request, 422, "Round must be an integer.");
          // NOTE: ?refresh=true is accepted but does NOT bypass the edge cache.
          // With hundreds of clients polling, honouring it would stampede
          // chess-results.com. The 12s TTL already beats the 15s minimum poll.
          return await handleRound(request, ctx, tnr, rd);
        }
        return await handleSearch(request, ctx, tnr, url);
      }

      return fail(request, 404, "Not Found");
    } catch (error) {
      const status = error?.status || (error?.name === "TimeoutError" ? 504 : 500);
      return fail(request, status, error?.message || "Unexpected error.");
    }
  },
};

// Exported for local testing; unused by the Workers runtime.
export {
  extractTables,
  parseRoundPairings,
  parseStartingRank,
  enrichWithStartList,
  parseTitle,
  parseShownRound,
  parseLastUpdate,
  matchPlayerFlexible,
  extractTnr,
};
