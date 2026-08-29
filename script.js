/* ------------------------------------------------------------------ */
/* Pairing Board — network layer (Cloudflare Worker backed)            */
/*                                                                    */
/* Replaces the old corsproxy.io / allorigins fallback. Everything     */
/* goes through your Worker, which adds the CORS headers, parses the   */
/* chess-results HTML, and caches at the edge.                         */
/*                                                                    */
/* Loaded BEFORE the inline <script> in index.html. It defines         */
/* loadTournament / loadRound, which the inline script calls; it uses  */
/* state, renderUI and $ from that script at call time.                */
/* ------------------------------------------------------------------ */

/* Your deployed Worker origin. No trailing slash. */
const API_BASE = "https://chess-results-proxy.YOUR-SUBDOMAIN.workers.dev";

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Single fetch helper: absolute URL, CORS, timeout, and FastAPI-style
 * {"detail": "..."} error bodies surfaced as real Error messages.
 */
async function apiGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Bad response from proxy (HTTP ${res.status}).`);
    }

    if (!res.ok) throw new Error(body?.detail || `Request failed (HTTP ${res.status}).`);
    return body;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out.");
    if (err instanceof TypeError) throw new Error("Cannot reach the pairing service.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Raw HTML fallback — same Worker, /raw passthrough                   */
/* Kept so parseHTMLPairings() below still works if the JSON API fails */
/* ------------------------------------------------------------------ */
async function fetchRawChessResults(tnr, art = 2, rd = 1) {
  const target = `https://chess-results.com/tnr${tnr}.aspx?lan=1&art=${art}&rd=${rd}&turdet=YES&zeilen=99999`;
  const res = await fetch(`${API_BASE}/raw?url=${encodeURIComponent(target)}`, {
    mode: "cors",
    credentials: "omit",
  });
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}.`);
  return await res.text();
}

/* Unchanged from the original file — parses a chess-results page in-browser. */
function parseHTMLPairings(html, tnr, rd) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const titleEl =
    doc.querySelector(".CRs1Title") || doc.querySelector("h2") ||
    doc.querySelector(".defaultDialog b") || doc.querySelector("title");
  let tname = titleEl ? titleEl.textContent.trim() : `Tournament ${tnr}`;
  tname = tname
    .replace(/^Chess-Results\s*Server\s*/i, "")
    .replace(/^chess-results\.com\s*-\s*/i, "")
    .replace(/^\d+\.\s*/, "");

  let table = null;
  for (const t of doc.querySelectorAll("table.CRs1")) {
    const headText = t.textContent.toLowerCase();
    if (headText.includes("bo.") || headText.includes("board") || headText.includes("white")) {
      table = t;
      break;
    }
  }
  if (!table) return null;

  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length < 2) return null;

  const headers = Array.from(rows[0].querySelectorAll("th, td"))
    .map(el => el.textContent.trim().toLowerCase());
  const colIdx = (...names) => {
    const idxs = [];
    headers.forEach((h, i) => {
      if (names.some(n => h === n || h.startsWith(n))) idxs.push(i);
    });
    return idxs;
  };

  const boards = colIdx("bo.", "brett", "board", "№");
  const numbers = colIdx("no.", "snr", "nr.");
  const names = colIdx("name", "white", "black", "weiss", "schwarz", "белые", "черные");
  const ratings = colIdx("rtg", "rtgi", "elo", "rating");
  const points = colIdx("pts.", "pkt");
  const results = colIdx("result", "res.", "erg.");

  const toInt = s => { const m = (s || "").match(/\d+/); return m ? parseInt(m[0], 10) : null; };
  const toPts = s => {
    const m = (s || "").replace("½", ".5").match(/\d+(\.\d+)?|\.5/);
    return m ? parseFloat(m[0].startsWith(".") ? "0" + m[0] : m[0]) : null;
  };

  const pairings = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = Array.from(rows[i].querySelectorAll("td")).map(td => td.textContent.trim());
    if (cells.length < 4) continue;
    const get = (idxs, w) => (idxs[w] != null && idxs[w] < cells.length) ? cells[idxs[w]] : "";

    const boardVal = parseInt(get(boards, 0), 10);
    const wName = get(names, 0);
    const bName = get(names, 1);
    if (!boardVal || !wName) continue;

    const unpaired = !bName || /^not paired$/i.test(bName);
    pairings.push({
      board: boardVal,
      white: {
        name: wName, rating: toInt(get(ratings, 0)), fide_id: null,
        start_no: toInt(get(numbers, 0)), points: toPts(get(points, 0)), federation: null,
      },
      black: {
        name: unpaired ? "— bye —" : bName,
        rating: unpaired ? null : toInt(get(ratings, 1)), fide_id: null,
        start_no: unpaired ? null : toInt(get(numbers, 1)),
        points: unpaired ? null : toPts(get(points, 1)), federation: null,
      },
      result: get(results, 0) || null,
    });
  }

  return {
    tournament_id: tnr,
    tournament_name: tname,
    round: rd,
    fetched_at: Date.now() / 1000,
    total_boards: pairings.length,
    pairings,
  };
}

/* ------------------------------------------------------------------ */
/* Load & sync                                                        */
/* ------------------------------------------------------------------ */

async function loadTournament(tnrOrUrl, rd = 1) {
  state.isLoading = true;
  const tnr = extractTnrId(tnrOrUrl);
  state.tnr = tnr;
  $("tnrInput").value = tnr;
  window.location.hash = tnr;
  $("statusTxt").textContent = "Fetching…";

  try {
    // The Worker probes rounds server-side and caches for 2 minutes, so this is
    // one request instead of the 15 concurrent probes the old client did.
    state.meta = await apiGet(`/api/tournament/${encodeURIComponent(tnr)}`);
    state.roundsAvailable = state.meta.available_rounds || [1];
    state.useClientScraper = false;

    const target = state.roundsAvailable.includes(rd)
      ? rd
      : state.roundsAvailable[state.roundsAvailable.length - 1];
    await loadRound(tnr, target);
  } catch (err) {
    console.warn("Worker metadata unavailable, falling back to raw scrape:", err.message);
    state.useClientScraper = true;
    state.meta = null;
    state.roundsAvailable = [rd];
    try {
      await loadRound(tnr, rd);
    } catch {
      $("statusTxt").textContent = "Error";
      $("stateMsg").textContent = `Could not load tournament ${tnr}: ${err.message}`;
    }
  } finally {
    state.isLoading = false;
  }
}

async function loadRound(tnr, rd, refresh = false) {
  $("statusTxt").textContent = refresh ? "Updating…" : "Loading R" + rd;
  state.round = rd;

  if (!state.useClientScraper) {
    try {
      state.roundData = await apiGet(`/api/tournament/${encodeURIComponent(tnr)}/round/${rd}`);
      if (!state.meta) {
        state.meta = {
          tournament_name: state.roundData.tournament_name,
          total_players: 0,
          available_rounds: state.roundsAvailable,
        };
      }
      $("statusTxt").textContent = "LIVE";
      renderUI();
      return;
    } catch (err) {
      // A failed background refresh must not wipe good pairings off the screen.
      if (refresh && state.roundData) {
        $("statusTxt").textContent = "Stale";
        return;
      }
      console.warn("JSON API failed, trying raw scrape:", err.message);
      state.useClientScraper = true;
    }
  }

  try {
    const html = await fetchRawChessResults(tnr, 2, rd);
    const parsed = parseHTMLPairings(html, tnr, rd);
    if (!parsed) throw new Error("Could not parse pairings.");
    state.roundData = parsed;
    state.meta = { tournament_name: parsed.tournament_name, total_players: 0 };
    $("statusTxt").textContent = "LIVE (raw)";
    renderUI();
  } catch (err) {
    if (refresh && state.roundData) {
      $("statusTxt").textContent = "Stale";
      return;
    }
    $("statusTxt").textContent = "Error";
    state.roundData = null;
    renderUI();
    $("stateMsg").textContent = `Round ${rd} could not be loaded: ${err.message}`;
  }
}
