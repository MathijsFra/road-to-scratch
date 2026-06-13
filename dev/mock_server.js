#!/usr/bin/env node
/**
 * Lokale mock-server die de Supabase API nabootst voor dev/testing.
 *
 * Start:  node dev/mock_server.js
 * Port:   3001 (app via config.js wanneer DEV_MODE=true in localStorage)
 *
 * Ondersteunt:
 *   - POST /auth/v1/token       → fake login (elk wachtwoord werkt)
 *   - GET  /auth/v1/user        → geeft dev-gebruiker terug
 *   - POST /auth/v1/logout      → 204
 *   - GET  /rest/v1/<table>     → fixture JSON met basis PostgREST filtering
 *   - POST /rest/v1/<table>     → 201 (in-memory, lost na herstart)
 *   - PATCH/DELETE              → 204 (no-op, logt de wijziging)
 *   - /functions/v1/*           → 200 {} (edge functions zijn no-op)
 */

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dir, "fixtures");
const PORT = 3001;
const DEV_USER_ID = "b4fb2369-9c6b-4109-bb4b-c47f006839e9";

const DEV_USER = {
  id: DEV_USER_ID,
  email: "dev@roadtoscratch.nl",
  role: "authenticated",
  aud: "authenticated",
  created_at: "2026-01-01T00:00:00.000Z",
};

// In-memory overlay voor PATCH/POST writes (zodat wijzigingen in de sessie zichtbaar zijn)
const writes = {};

function loadFixture(name) {
  const path = join(FIXTURES_DIR, `${name}.json`);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
}

// Basisfiltering op PostgREST query params: eq., is.null, order, select
function applyFilters(rows, params) {
  let result = [...rows];
  for (const [key, val] of params.entries()) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (val === "is.null") { result = result.filter(r => r[key] == null); continue; }
    if (val === "not.is.null") { result = result.filter(r => r[key] != null); continue; }
    const eq = val.match(/^eq\.(.+)$/);
    if (eq) result = result.filter(r => String(r[key]) === eq[1]);
    const in_ = val.match(/^in\.\((.+)\)$/);
    if (in_) { const vals = in_[1].split(",").map(v => v.replace(/^"|"$/g, "")); result = result.filter(r => vals.includes(String(r[key]))); }
  }
  const order = params.get("order");
  if (order) {
    const [field, dir] = order.split(".");
    result.sort((a, b) => {
      const av = a[field], bv = b[field];
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "desc" ? (av < bv ? 1 : -1) : (av > bv ? 1 : -1);
    });
  }
  const limit = params.get("limit");
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

// Merge fixture data with any in-memory writes
function getData(table) {
  const base = loadFixture(table);
  const overlay = writes[table] || {};
  return base.map(row => overlay[row.id] ? { ...row, ...overlay[row.id] } : row);
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, Prefer, X-Client-Info");
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (path === "/auth/v1/token") {
    return json(res, 200, {
      access_token: "dev-access-token",
      token_type: "bearer",
      expires_in: 86400,
      refresh_token: "dev-refresh-token",
      user: DEV_USER,
    });
  }
  if (path === "/auth/v1/user") {
    return json(res, 200, DEV_USER);
  }
  if (path === "/auth/v1/logout") {
    res.writeHead(204); res.end(); return;
  }
  if (path === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    return json(res, 200, { access_token: "dev-access-token", token_type: "bearer", expires_in: 86400 });
  }

  // ── PostgREST ─────────────────────────────────────────────────────────────
  if (path.startsWith("/rest/v1/")) {
    const table = path.slice("/rest/v1/".length);

    if (method === "GET") {
      const rows = getData(table);
      const filtered = applyFilters(rows, url.searchParams);
      // PostgREST returns array unless Accept: application/vnd.pgrst.object+json
      return json(res, 200, filtered);
    }

    if (method === "POST") {
      const body = await readBody(req);
      const rows = Array.isArray(body) ? body : [body];
      const withIds = rows.map(r => ({ id: r.id || crypto.randomUUID(), ...r }));
      if (!writes[table]) writes[table] = {};
      withIds.forEach(r => { writes[table][r.id] = r; });
      console.log(`  POST ${table}: +${withIds.length} rij(en)`);
      const prefer = req.headers["prefer"] || "";
      if (prefer.includes("return=representation")) return json(res, 201, withIds);
      res.writeHead(201); res.end(); return;
    }

    if (method === "PATCH") {
      const body = await readBody(req);
      // Find matching rows and log
      const rows = getData(table);
      const filtered = applyFilters(rows, url.searchParams);
      if (!writes[table]) writes[table] = {};
      filtered.forEach(r => { writes[table][r.id] = { ...(writes[table][r.id] || r), ...body }; });
      console.log(`  PATCH ${table} (${filtered.length} rij): ${JSON.stringify(body).slice(0, 80)}`);
      res.writeHead(204); res.end(); return;
    }

    if (method === "DELETE") {
      console.log(`  DELETE ${table}`);
      res.writeHead(204); res.end(); return;
    }
  }

  // ── Edge Functions ────────────────────────────────────────────────────────
  if (path.startsWith("/functions/v1/")) {
    const fn = path.slice("/functions/v1/".length);
    console.log(`  Edge function: ${fn} (no-op)`);

    // get-toptracer-creds: return empty list (geen sync in dev)
    if (fn === "get-toptracer-creds") return json(res, 200, []);
    return json(res, 200, {});
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: `Not found: ${path}` }));
});

server.listen(PORT, () => {
  console.log(`\n🏌️  Road to Scratch — mock server`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`Schakel dev-modus in via de browser console:`);
  console.log(`   localStorage.setItem('DEV_MODE', 'true'); location.reload();\n`);
  console.log(`Schakel uit:`);
  console.log(`   localStorage.removeItem('DEV_MODE'); location.reload();\n`);
});
