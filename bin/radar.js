#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const UA = 'token-radar/1.2.1 (+local discovery CLI)';
const DEFAULT_CHAINS = ['robinhood', 'base', 'solana'];
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'out');

// Ranking / filter defaults (1.2 — breaking vs prior "keep all")
const DEFAULT_MIN_LIQ = 500;
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_MIN_VOL = 0; // off unless > 0
const DEFAULT_TOP = 25;
const HARD_DUST_LIQ = 50; // always drop if liq present and < this

const DS_FETCH_OPTS = {
  retries: 5,
  backoff: { baseMs: 2000, capMs: 45000, jitterMs: 500 },
};

const GT_FETCH_OPTS = {
  retries: 5,
  backoff: { baseMs: 2000, capMs: 45000, jitterMs: 500 },
};

// Prefer this order when intersecting with requested chains (stable, not Set iteration)
const GT_NETWORK_PREF = ['robinhood', 'base', 'solana'];

// Known quote / wrapped tokens to skip when they appear as base_token
const SKIP_BASE = new Set([
  // Solana
  'so11111111111111111111111111111111111111112', // WSOL
  'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', // USDC
  'es9vmfrsacqj9gp6qgbaxwenhaakebabxnvdcd07uhw', // USDT
  'usd1ttgy1nujrsgxm7wrm9cmvydtd9wrj9tx8rhfqqo', // USD1 sometimes
  // Base / EVM common
  '0x4200000000000000000000000000000000000006', // WETH Base
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI Base
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC Base
]);

function parseArgs(argv) {
  const out = {
    command: null,
    chains: null,
    out: null,
    help: false,
    maxAgeHours: undefined, // undefined = use default; null only if explicitly needed
    minLiq: undefined,
    minVol: undefined,
    requireMetrics: false,
    top: undefined,
    all: false,
    noOut: false,
    quietStdout: false,
    stdoutOnly: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--chains' || a === '--chain') out.chains = args[++i];
    else if (a === '--out') out.out = args[++i];
    else if (a === '--no-out') out.noOut = true;
    else if (a === '--quiet-stdout') out.quietStdout = true;
    else if (a === '--stdout-only') out.stdoutOnly = true;
    else if (a === '--max-age-hours') out.maxAgeHours = Number(args[++i]);
    else if (a === '--min-liq') out.minLiq = Number(args[++i]);
    else if (a === '--min-vol') out.minVol = Number(args[++i]);
    else if (a === '--top') out.top = Number(args[++i]);
    else if (a === '--all') out.all = true;
    else if (a === '--require-metrics') out.requireMetrics = true;
    else if (!a.startsWith('-') && !out.command) out.command = a;
    else {
      // ignore unknown for forward-compat
    }
  }
  return out;
}

function usage() {
  return [
    'token-radar — free token discovery CLI (Discord-independent coverage)',
    '',
    'Usage:',
    '  radar once [--chains robinhood,base,solana] [--out path.jsonl]',
    '             [--max-age-hours N] [--min-liq USD] [--min-vol USD] [--require-metrics]',
    '             [--top N] [--all] [--no-out] [--quiet-stdout]',
    '',
    'Flags:',
    '  --chains / --chain <csv>  Network slugs (default: robinhood,base,solana)',
    '  --out <path>              Write JSONL to file (default: auto under out/)',
    '  --no-out                  Skip durable file write',
    '  --quiet-stdout            Suppress ranked JSONL on stdout (stderr summary still printed)',
    '  --stdout-only             Alias for --no-out (stream only; no durable file)',
    '  --max-age-hours <n>       Drop if pool_created_at older than n hours; keep if missing',
    '                            (default: 24)',
    '  --min-liq <usd>           Drop if liquidity_usd present and below threshold; keep if null',
    '                            (default: 500). Hard dust floor: always drop if liq present and < 50',
    '  --min-vol <usd>           Drop if volume_h24_usd present and below threshold; keep if null',
    '                            (default: 0 = off)',
    '  --top <n>                 Emit only top N after ranking (default: 25)',
    '  --all                     Emit all ranked candidates (ignore --top)',
    '  --require-metrics         With age/liq/vol filters, also drop candidates missing those metrics',
    '  --help                    Show this help',
    '',
    'Stdout = ranked JSONL lines; stderr = summary. Durable file written unless --no-out.',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isRateLimited(status, text) {
  if (status === 429) return true;
  const s = String(text || '');
  return /1015|cloudflare|rate.?limit|too many requests/i.test(s);
}

function parseRetryAfterMs(headerVal) {
  if (headerVal == null || headerVal === '') return null;
  const asNum = Number(headerVal);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 60000);
  const when = Date.parse(headerVal);
  if (Number.isFinite(when)) {
    const ms = when - Date.now();
    if (ms > 0) return Math.min(ms, 60000);
  }
  return null;
}

function backoffMs(attempt, retryAfterMs, opts = {}) {
  const baseStart = opts.baseMs != null ? opts.baseMs : 1000;
  const cap = opts.capMs != null ? opts.capMs : 16000;
  const jitterMax = opts.jitterMs != null ? opts.jitterMs : 250;
  const base = Math.min(baseStart * Math.pow(2, attempt), cap);
  const jitter = Math.floor(Math.random() * (jitterMax + 1));
  const fromHeader = retryAfterMs != null ? retryAfterMs : 0;
  return Math.max(base + jitter, fromHeader);
}

async function fetchJson(url, { timeoutMs = 20000, retries = 3, backoff = null } = {}) {
  const bo = backoff || { baseMs: 1000, capMs: 16000, jitterMs: 250 };
  let lastErr = null;
  let lastStatus = 0;
  let lastBody = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text.slice(0, 500) };
      }

      const rateLimited = isRateLimited(res.status, text);
      if (rateLimited) {
        lastErr = Object.assign(new Error('HTTP ' + res.status + ' rate-limited'), {
          status: res.status,
          body,
          rateLimited: true,
        });
        lastStatus = res.status;
        lastBody = body;
        if (attempt < retries) {
          const ra = parseRetryAfterMs(res.headers.get('retry-after'));
          await sleep(backoffMs(attempt, ra, bo));
          continue;
        }
        return { ok: false, status: res.status, body, error: lastErr, rateLimited: true };
      }

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          body,
          error: Object.assign(new Error('HTTP ' + res.status), { status: res.status, body }),
          rateLimited: false,
        };
      }
      return { ok: true, status: res.status, body, rateLimited: false };
    } catch (err) {
      lastErr = err;
      lastStatus = 0;
      lastBody = null;
      if (attempt < retries) {
        await sleep(backoffMs(attempt, null, bo));
        continue;
      }
      return { ok: false, status: 0, body: null, error: err, rateLimited: false };
    } finally {
      clearTimeout(t);
    }
  }
  return {
    ok: false,
    status: lastStatus,
    body: lastBody,
    error: lastErr,
    rateLimited: !!(lastErr && lastErr.rateLimited),
  };
}

function normalizeChain(c) {
  return String(c || '').trim().toLowerCase();
}

function extractAddressFromGeckoId(id) {
  // e.g. solana_<CA> or base_0x...
  if (!id || typeof id !== 'string') return null;
  const idx = id.indexOf('_');
  if (idx < 0) return null;
  return id.slice(idx + 1);
}

function shouldSkipAddress(address) {
  if (!address) return true;
  return SKIP_BASE.has(String(address).toLowerCase());
}

function candidateKey(chain, address) {
  return normalizeChain(chain) + '|' + String(address).toLowerCase();
}

function mergeCandidate(map, partial) {
  const key = candidateKey(partial.chain, partial.address);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, {
      chain: normalizeChain(partial.chain),
      address: partial.address,
      sources: Array.isArray(partial.sources) ? [...partial.sources] : [],
      signal: partial.signal || null,
      name: partial.name || null,
      pool: partial.pool || null,
      liquidity_usd: partial.liquidity_usd != null ? partial.liquidity_usd : null,
      volume_h24_usd: partial.volume_h24_usd != null ? partial.volume_h24_usd : null,
      mcap_usd: partial.mcap_usd != null ? partial.mcap_usd : null,
      fdv_usd: partial.fdv_usd != null ? partial.fdv_usd : null,
      pool_created_at: partial.pool_created_at || null,
      url: partial.url || null,
      description: partial.description || undefined,
      amount: partial.amount != null ? partial.amount : undefined,
      totalAmount: partial.totalAmount != null ? partial.totalAmount : undefined,
      discovered_at: partial.discovered_at || new Date().toISOString(),
    });
    return;
  }
  for (const s of partial.sources || []) {
    if (!existing.sources.includes(s)) existing.sources.push(s);
  }
  // Prefer richer fields; keep earliest signal priority: new_pool > boost > profile if unset
  if (!existing.name && partial.name) existing.name = partial.name;
  if (!existing.pool && partial.pool) existing.pool = partial.pool;
  if (existing.liquidity_usd == null && partial.liquidity_usd != null) {
    existing.liquidity_usd = partial.liquidity_usd;
  }
  if (existing.volume_h24_usd == null && partial.volume_h24_usd != null) {
    existing.volume_h24_usd = partial.volume_h24_usd;
  }
  if (existing.mcap_usd == null && partial.mcap_usd != null) {
    existing.mcap_usd = partial.mcap_usd;
  }
  if (existing.fdv_usd == null && partial.fdv_usd != null) {
    existing.fdv_usd = partial.fdv_usd;
  }
  if (!existing.pool_created_at && partial.pool_created_at) {
    existing.pool_created_at = partial.pool_created_at;
  }
  if (!existing.url && partial.url) existing.url = partial.url;
  if (existing.description == null && partial.description) {
    existing.description = partial.description;
  }
  if (existing.amount == null && partial.amount != null) existing.amount = partial.amount;
  if (existing.totalAmount == null && partial.totalAmount != null) {
    existing.totalAmount = partial.totalAmount;
  }
  // Prefer new_pool signal if merging
  if (partial.signal === 'new_pool') existing.signal = 'new_pool';
  else if (!existing.signal && partial.signal) existing.signal = partial.signal;
}

function orderedGtNetworks(chainsSet) {
  const preferred = GT_NETWORK_PREF.filter((n) => chainsSet.has(n));
  const rest = [...chainsSet]
    .filter((n) => !GT_NETWORK_PREF.includes(n))
    .sort();
  return preferred.concat(rest);
}

/** @returns {{ ok: boolean, rateLimited: boolean }} */
async function fetchGeckoNewPools(network, map, stats) {
  const sourceTag = 'geckoterminal:new_pools';
  const url =
    'https://api.geckoterminal.com/api/v2/networks/' +
    encodeURIComponent(network) +
    '/new_pools?page=1';
  const label = 'gt:' + network;
  const res = await fetchJson(url, GT_FETCH_OPTS);
  if (!res.ok) {
    const already = stats.failures.some((f) => f.source === label);
    if (!already) {
      stats.failures.push({ source: label, rateLimited: !!res.rateLimited, status: res.status });
    } else {
      for (const f of stats.failures) {
        if (f.source === label) {
          f.rateLimited = !!res.rateLimited;
          f.status = res.status;
        }
      }
    }
    if (res.rateLimited && !stats.rateLimited.includes(label)) {
      stats.rateLimited.push(label);
    }
    return { ok: false, rateLimited: !!res.rateLimited };
  }
  // Success: clear prior failure/rateLimited marks (deferred retry)
  stats.failures = stats.failures.filter((f) => f.source !== label);
  stats.rateLimited = stats.rateLimited.filter((s) => s !== label);
  stats.okSources.add(label);
  const data = (res.body && res.body.data) || [];
  let added = 0;
  for (const item of data) {
    const attrs = (item && item.attributes) || {};
    const rel = (item && item.relationships) || {};
    const baseId =
      (rel.base_token && rel.base_token.data && rel.base_token.data.id) ||
      null;
    let address = extractAddressFromGeckoId(baseId);
    // Fallback: some responses embed address in attributes
    if (!address && attrs.address) {
      // pool address is not token — skip fallback to pool
      address = null;
    }
    if (!address || shouldSkipAddress(address)) continue;

    const name = attrs.name || null;
    const poolAddr = attrs.address || (item && item.id ? extractAddressFromGeckoId(item.id) : null);
    mergeCandidate(map, {
      chain: network,
      address,
      sources: [sourceTag],
      signal: 'new_pool',
      name,
      pool: poolAddr,
      liquidity_usd: num(attrs.reserve_in_usd),
      volume_h24_usd: num(attrs.volume_usd && attrs.volume_usd.h24),
      mcap_usd: num(attrs.market_cap_usd),
      fdv_usd: num(attrs.fdv_usd),
      pool_created_at: attrs.pool_created_at || null,
      url: null,
      discovered_at: new Date().toISOString(),
    });
    added++;
  }
  stats.bySource[sourceTag] = (stats.bySource[sourceTag] || 0) + added;
  return { ok: true, rateLimited: false };
}

function chainAllowed(chainId, chainsSet) {
  const c = normalizeChain(chainId);
  // Explicitly reject numeric chain ids like 4663
  if (/^\d+$/.test(c)) return false;
  return chainsSet.has(c);
}

/** @returns {{ ok: boolean, rateLimited: boolean }} */
async function fetchDexScreener(endpoint, signal, sourceTag, chainsSet, map, stats, fetchOpts) {
  const res = await fetchJson(endpoint, fetchOpts || DS_FETCH_OPTS);
  const label = sourceTag;
  if (!res.ok) {
    // Avoid duplicate failure entries on deferred retry of same source
    const already = stats.failures.some((f) => f.source === label);
    if (!already) {
      stats.failures.push({ source: label, rateLimited: !!res.rateLimited, status: res.status });
    } else {
      // Update last failure status
      for (const f of stats.failures) {
        if (f.source === label) {
          f.rateLimited = !!res.rateLimited;
          f.status = res.status;
        }
      }
    }
    if (res.rateLimited && !stats.rateLimited.includes(label)) {
      stats.rateLimited.push(label);
    }
    return { ok: false, rateLimited: !!res.rateLimited };
  }
  // Success: clear prior failure/rateLimited marks for this source (deferred retry)
  stats.failures = stats.failures.filter((f) => f.source !== label);
  stats.rateLimited = stats.rateLimited.filter((s) => s !== label);
  stats.okSources.add(label);
  const list = Array.isArray(res.body) ? res.body : [];
  let added = 0;
  for (const item of list) {
    if (!item) continue;
    const chainId = item.chainId || item.chain || item.network;
    if (!chainAllowed(chainId, chainsSet)) continue;
    const address = item.tokenAddress || item.address;
    if (!address || shouldSkipAddress(address)) continue;

    const desc =
      typeof item.description === 'string'
        ? item.description.slice(0, 200)
        : undefined;

    mergeCandidate(map, {
      chain: normalizeChain(chainId),
      address,
      sources: [sourceTag],
      signal,
      name: item.name || item.symbol || null,
      pool: null,
      liquidity_usd: null,
      volume_h24_usd: null,
      mcap_usd: null,
      fdv_usd: null,
      pool_created_at: null,
      url: item.url || item.links && item.links[0] && (item.links[0].url || item.links[0]) || null,
      description: desc,
      amount: item.amount != null ? num(item.amount) : undefined,
      totalAmount: item.totalAmount != null ? num(item.totalAmount) : undefined,
      discovered_at: new Date().toISOString(),
    });
    added++;
  }
  stats.bySource[sourceTag] = (stats.bySource[sourceTag] || 0) + added;
  return { ok: true, rateLimited: false };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function applyFilters(candidates, filters) {
  const { maxAgeHours, minLiq, minVol, requireMetrics } = filters;
  const hasAge = maxAgeHours != null && Number.isFinite(maxAgeHours);
  const hasLiq = minLiq != null && Number.isFinite(minLiq) && minLiq > 0;
  const hasVol = minVol != null && Number.isFinite(minVol) && minVol > 0;
  const now = Date.now();
  const maxAgeMs = hasAge ? maxAgeHours * 3600 * 1000 : null;
  let filteredOut = 0;
  const kept = [];

  for (const c of candidates) {
    let drop = false;

    // Hard dust floor: always drop if liq present and < HARD_DUST_LIQ
    if (c.liquidity_usd != null && c.liquidity_usd < HARD_DUST_LIQ) {
      drop = true;
    }

    if (!drop && hasAge) {
      if (c.pool_created_at) {
        const created = Date.parse(c.pool_created_at);
        if (Number.isFinite(created) && now - created > maxAgeMs) drop = true;
      } else if (requireMetrics) {
        drop = true;
      }
    }

    if (!drop && hasLiq) {
      if (c.liquidity_usd != null) {
        if (c.liquidity_usd < minLiq) drop = true;
      } else if (requireMetrics) {
        drop = true;
      }
    }

    if (!drop && hasVol) {
      if (c.volume_h24_usd != null) {
        if (c.volume_h24_usd < minVol) drop = true;
      } else if (requireMetrics) {
        drop = true;
      }
    }

    if (drop) filteredOut++;
    else kept.push(c);
  }

  return { candidates: kept, filteredOut };
}

function sourceFamilies(sources) {
  const fams = new Set();
  for (const s of sources || []) {
    const t = String(s).toLowerCase();
    if (t.startsWith('geckoterminal') || t.startsWith('gt:')) fams.add('gt');
    else if (t.startsWith('dexscreener') || t.startsWith('ds:')) fams.add('ds');
  }
  return fams;
}

function ageHours(c) {
  if (!c.pool_created_at) return null;
  const created = Date.parse(c.pool_created_at);
  if (!Number.isFinite(created)) return null;
  return (Date.now() - created) / 3600000;
}

function scoreCandidate(c) {
  const reasons = [];
  let score = 0;
  const fams = sourceFamilies(c.sources);
  const nFam = fams.size;
  if (nFam > 0) {
    score += 3 * nFam;
    reasons.push('source_families:' + nFam + '(+' + 3 * nFam + ')');
  }
  if (fams.has('gt') && fams.has('ds')) {
    score += 5;
    reasons.push('multi_source_agree(+5)');
  }
  if (c.liquidity_usd != null && Number.isFinite(c.liquidity_usd)) {
    const liqPts = Math.log10(c.liquidity_usd + 1) * 2;
    score += liqPts;
    reasons.push('liq_log(+'+ liqPts.toFixed(2) + ')');
  }
  if (c.volume_h24_usd != null && Number.isFinite(c.volume_h24_usd)) {
    const volPts = Math.log10(c.volume_h24_usd + 1);
    score += volPts;
    reasons.push('vol_log(+'+ volPts.toFixed(2) + ')');
  }
  const ageH = ageHours(c);
  if (c.signal === 'new_pool') {
    if (ageH != null && ageH < 6) {
      score += 4;
      reasons.push('new_pool_lt6h(+4)');
    } else if (ageH != null && ageH < 24) {
      score += 2;
      reasons.push('new_pool_lt24h(+2)');
    } else if (ageH == null) {
      // no age bonus
    }
  }
  if (c.signal === 'boost') {
    score += 3;
    reasons.push('boost(+3)');
    const amt = c.amount != null ? c.amount : c.totalAmount;
    if (amt != null && Number.isFinite(amt) && amt > 0) {
      // light velocity proxy: log10(amount+1) capped ~2
      const boostVel = Math.min(Math.log10(amt + 1), 2);
      score += boostVel;
      reasons.push('boost_vel(+'+ boostVel.toFixed(2) + ')');
    }
  }
  if (c.signal === 'profile') {
    score += 2;
    reasons.push('profile(+2)');
  }
  // Attention-only deprioritize: only DS boost/profile with no liq/vol
  const onlyDs =
    fams.has('ds') &&
    !fams.has('gt') &&
    (c.signal === 'boost' || c.signal === 'profile');
  if (onlyDs && c.liquidity_usd == null && c.volume_h24_usd == null) {
    score -= 5;
    reasons.push('attention_only(-5)');
  }

  // Round for stable JSON
  score = Math.round(score * 100) / 100;
  return { score, score_reasons: reasons };
}

function rankCandidates(candidates) {
  const scored = candidates.map((c) => {
    const { score, score_reasons } = scoreCandidate(c);
    return { ...c, score, score_reasons };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const la = a.liquidity_usd != null ? a.liquidity_usd : -1;
    const lb = b.liquidity_usd != null ? b.liquidity_usd : -1;
    return lb - la;
  });
  return scored.map((c, i) => ({ ...c, rank: i + 1 }));
}

function chainsSlug(chains) {
  const def = DEFAULT_CHAINS.join(',');
  const got = chains.map(normalizeChain).join(',');
  if (got === def) return 'all';
  return chains.map(normalizeChain).filter(Boolean).join('-') || 'all';
}

function stampLocal() {
  // Local wall clock for filename (idempotent timestamped files)
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function defaultOutPath(chains) {
  fs.mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  return path.join(
    DEFAULT_OUT_DIR,
    'radar-' + chainsSlug(chains) + '-' + stampLocal() + '.jsonl'
  );
}

function dsStaggerMs() {
  // ~1.5–2s between DexScreener endpoints
  return 1500 + Math.floor(Math.random() * 501);
}

function gtPoliteMs() {
  // ~2500–3500ms between GeckoTerminal networks (Substrate-like)
  return 2500 + Math.floor(Math.random() * 1001);
}

function gtRateLimitCoolMs() {
  // Extra cool-down after a network exhausted retries on 429 before next GT network
  return 5000 + Math.floor(Math.random() * 3001);
}

async function runOnce(chains, opts) {
  const {
    outPath,
    noOut,
    quietStdout,
    filters,
    top,
    emitAll,
  } = opts;

  const chainsSet = new Set(chains.map(normalizeChain).filter(Boolean));
  const map = new Map();
  const stats = {
    bySource: {},
    rateLimited: [],
    failures: [],
    okSources: new Set(),
  };

  // GeckoTerminal new pools per network (polite delay; stable network order)
  const gtNetworks = orderedGtNetworks(chainsSet);
  const gtRateLimitedNetworks = [];
  let gtFirst = true;
  let prevGtRateLimited = false;
  for (const network of gtNetworks) {
    if (!gtFirst) {
      await sleep(gtPoliteMs());
      if (prevGtRateLimited) await sleep(gtRateLimitCoolMs());
    }
    gtFirst = false;
    const gtResult = await fetchGeckoNewPools(network, map, stats);
    prevGtRateLimited = !!(gtResult && gtResult.rateLimited && !gtResult.ok);
    if (prevGtRateLimited) gtRateLimitedNetworks.push(network);
  }

  // DexScreener endpoints — staggered; boosts_latest gets deferred retry on 429
  const boostsLatestUrl = 'https://api.dexscreener.com/token-boosts/latest/v1';
  const boostsLatestTag = 'dexscreener:boosts_latest';

  const boostsLatestResult = await fetchDexScreener(
    boostsLatestUrl,
    'boost',
    boostsLatestTag,
    chainsSet,
    map,
    stats,
    DS_FETCH_OPTS
  );

  await sleep(dsStaggerMs());
  await fetchDexScreener(
    'https://api.dexscreener.com/token-boosts/top/v1',
    'boost',
    'dexscreener:boosts_top',
    chainsSet,
    map,
    stats,
    DS_FETCH_OPTS
  );

  await sleep(dsStaggerMs());
  await fetchDexScreener(
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'profile',
    'dexscreener:profiles_latest',
    chainsSet,
    map,
    stats,
    DS_FETCH_OPTS
  );

  // Deferred retry: if boosts_latest was rate-limited, wait ~5s and try once more
  if (boostsLatestResult.rateLimited && !boostsLatestResult.ok) {
    await sleep(5000);
    await fetchDexScreener(
      boostsLatestUrl,
      'boost',
      boostsLatestTag,
      chainsSet,
      map,
      stats,
      DS_FETCH_OPTS
    );
  }

  // Deferred single retry for GT networks that exhausted retries on 429
  if (gtRateLimitedNetworks.length) {
    await sleep(5000);
    let gtRetryFirst = true;
    for (const network of gtRateLimitedNetworks) {
      if (!gtRetryFirst) await sleep(gtPoliteMs());
      gtRetryFirst = false;
      await fetchGeckoNewPools(network, map, stats);
    }
  }

  let candidates = [...map.values()].map(stripUndefined);
  const preFilterCount = candidates.length;
  const filterResult = applyFilters(candidates, filters || {});
  candidates = filterResult.candidates;
  const filteredOut = filterResult.filteredOut;

  // Rank
  candidates = rankCandidates(candidates);
  const rankedTotal = candidates.length;

  // Top-N slice (unless --all)
  let emitted = candidates;
  if (!emitAll && top != null && Number.isFinite(top) && top > 0) {
    emitted = candidates.slice(0, top);
  }
  // Re-number rank within emitted? Keep global rank from full ranked list.
  // Already have rank 1..N from full sort; slice preserves those ranks.

  // Per-chain counts (of emitted)
  const byChain = {};
  for (const c of emitted) {
    byChain[c.chain] = (byChain[c.chain] || 0) + 1;
  }
  const byChainRanked = {};
  for (const c of candidates) {
    byChainRanked[c.chain] = (byChainRanked[c.chain] || 0) + 1;
  }

  // Resolve durable path
  let resolvedOut = null;
  if (!noOut) {
    resolvedOut = outPath || defaultOutPath(chains);
  }

  const lines = emitted.map((c) => JSON.stringify(stripUndefined(c)));
  if (resolvedOut) {
    const dir = path.dirname(resolvedOut);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolvedOut, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    process.stderr.write(
      'wrote ' + emitted.length + ' candidates to ' + resolvedOut + '\n'
    );
  }

  if (!quietStdout) {
    try {
      for (const line of lines) {
        process.stdout.write(line + '\n');
      }
    } catch (err) {
      // Ignore broken pipe (e.g. `| head`) so --out file is still valid
      if (!(err && (err.code === 'EPIPE' || err.errno === -32))) throw err;
    }
  }
  if (typeof process.stdout.on === 'function') {
    process.stdout.on('error', (err) => {
      if (err && (err.code === 'EPIPE' || err.errno === -32)) return;
      throw err;
    });
  }

  // stderr summary
  const summary = {
    total_emitted: emitted.length,
    ranked_total: rankedTotal,
    pre_filter: preFilterCount,
    filtered_out: filteredOut,
    by_chain: byChain,
    by_chain_ranked: byChainRanked,
    by_source: stats.bySource,
    rate_limited: [...new Set(stats.rateLimited)],
    failures: stats.failures.length
      ? stats.failures.map((f) => f.source + (f.rateLimited ? '(429/CF)' : '(HTTP ' + f.status + ')'))
      : [],
    out: resolvedOut,
    top: emitAll ? null : top,
  };
  process.stderr.write(
    'summary: emitted=' +
      emitted.length +
      ' ranked=' +
      rankedTotal +
      ' filtered_out=' +
      filteredOut +
      ' | chains=' +
      JSON.stringify(byChain) +
      ' | sources=' +
      JSON.stringify(stats.bySource) +
      (summary.rate_limited.length
        ? ' | rate_limited=' + JSON.stringify(summary.rate_limited)
        : '') +
      (summary.failures.length ? ' | failures=' + JSON.stringify(summary.failures) : '') +
      (resolvedOut ? ' | out=' + resolvedOut : '') +
      '\n'
  );

  // Exit 0 on partial source failure if ≥1 candidate; exit 1 only if zero candidates AND all sources failed
  const allFailed = stats.okSources.size === 0;
  if (emitted.length === 0 && allFailed) {
    process.exitCode = 1;
  } else if (rankedTotal === 0 && allFailed) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
  return { candidates: emitted, ranked: candidates, summary };
}

async function main() {
  process.stdout.on('error', (err) => {
    if (err && (err.code === 'EPIPE' || err.errno === -32)) return;
    throw err;
  });

  const args = parseArgs(process.argv);
  if (args.help || !args.command) {
    process.stdout.write(usage() + '\n');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  if (args.command !== 'once') {
    process.stderr.write('Unknown command: ' + args.command + '\n\n' + usage() + '\n');
    process.exitCode = 1;
    return;
  }
  const chains = (args.chains || DEFAULT_CHAINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chains.length) {
    process.stderr.write('No chains specified\n');
    process.exitCode = 1;
    return;
  }

  const minLiq = args.minLiq !== undefined ? args.minLiq : DEFAULT_MIN_LIQ;
  const maxAgeHours =
    args.maxAgeHours !== undefined ? args.maxAgeHours : DEFAULT_MAX_AGE_HOURS;
  const minVol = args.minVol !== undefined ? args.minVol : DEFAULT_MIN_VOL;
  const top = args.top !== undefined ? args.top : DEFAULT_TOP;

  const filters = {
    maxAgeHours,
    minLiq,
    minVol,
    requireMetrics: !!args.requireMetrics,
  };

  const noOut = !!args.noOut || !!args.stdoutOnly;
  const quietStdout = !!args.quietStdout;

  await runOnce(chains, {
    outPath: args.out || null,
    noOut,
    quietStdout,
    filters,
    top,
    emitAll: !!args.all,
  });
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
