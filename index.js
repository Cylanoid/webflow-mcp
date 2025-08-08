'use strict';

/**
 * Webflow MCP Connector — v2-only (expanded for full Data API)
 * - Auth gate via x-api-token (CONNECTOR_API_TOKEN)
 * - Health, SSE (/sse)
 * - Collections (safe mode by env; full=true for site inventory)
 * - Items CRUD (fieldData), publish (publishTo)
 * - Clean JSON errors
 * - No Accept-Version; base URL is /v2; Content-Type only when body exists
 * - New: Full Data API pass-through, form-data support, mutation guards, scope check
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---- Env ----
const {
  PORT = 3000,
  NODE_ENV = 'production',
  WEBFLOW_API_KEY,
  WEBFLOW_SITE_ID,
  CONNECTOR_API_TOKEN,
  ARTICLES_COLLECTION_ID,
  RESOURCES_COLLECTION_ID,
  ALLOW_MUTATIONS = 'true',
  REQUIRE_DESTRUCTIVE_HEADER = 'true',
} = process.env;

const SERVICE_NAME = 'webflow-mcp';
const WF_API_BASE = 'https://api.webflow.com/v2';
console.log(`[${SERVICE_NAME}] Using Webflow v2 API base: ${WF_API_BASE}`);

// ---- Utilities ----
class HttpError extends Error {
  constructor(status, message, details) {
    super(message || `HTTP ${status}`);
    this.status = status || 500;
    this.details = details;
  }
}
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// ---- Gate: 401 if CONNECTOR_API_TOKEN is set ----
app.use((req, res, next) => {
  const expected = CONNECTOR_API_TOKEN;
  if (expected && !safeCompare(req.header('x-api-token') || '', expected)) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized',
      details: { code: 'MISSING_OR_INVALID_API_TOKEN' }
    });
  }
  next();
});

// ---- HTTP client (v2; supports FormData for uploads) ----
async function wf(method, path, { query, body } = {}) {
  if (!WEBFLOW_API_KEY) throw new HttpError(500, 'WEBFLOW_API_KEY is not configured');
  const url = new URL(WF_API_BASE + path);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }

  // Detect FormData; when present do NOT set Content-Type manually (boundary is auto-generated)
  const isForm = (typeof FormData !== 'undefined') && (body instanceof FormData);

  const headers = {
    'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
    'User-Agent': 'webflow-mcp/2.x',
  };
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.err || data?.message || data?.msg || `Webflow API error ${res.status}`;
    console.error(`[${SERVICE_NAME}] WF error: ${msg}`, { path, status: res.status });
    throw new HttpError(res.status, msg, { path, data, status: res.status });
  }
  return data;
}

// ---- Helpers ----
const resolveCollectionId = (idOrAlias) => {
  if (!idOrAlias) return idOrAlias;
  const low = String(idOrAlias).toLowerCase();
  if (low === 'articles') return ARTICLES_COLLECTION_ID;
  if (low === 'resources') return RESOURCES_COLLECTION_ID;
  return idOrAlias;
};

function toFieldDataShape(body) {
  const src = body || {};
  if (src.fieldData && typeof src.fieldData === 'object') return { ...src.fieldData };
  const fd = {};
  for (const [k, v] of Object.entries(src)) if (k !== 'fieldData') fd[k] = v;
  return fd;
}

function normalizeDraftArchive(fd, src) {
  const out = { ...fd };
  if (out._draft === undefined) {
    out._draft = src?.isDraft !== undefined ? !!src.isDraft : (src?._draft !== undefined ? !!src._draft : false);
  }
  if (out._archived === undefined) {
    out._archived = src?.isArchived !== undefined ? !!src.isArchived : (src?._archived !== undefined ? !!src._archived : false);
  }
  return out;
}

async function listAllItems(collectionId, pageSize = 100) {
  const items = [];
  let offset = 0;
  while (true) {
    const page = await wf('GET', `/collections/${collectionId}/items`, { query: { offset, limit: pageSize } });
    const arr = Array.isArray(page?.items) ? page.items : (Array.isArray(page) ? page : []);
    items.push(...arr);
    if (arr.length < pageSize) break;
    offset += pageSize;
  }
  return items;
}

async function listCollectionsForSite(siteId) {
  const resp = await wf('GET', `/sites/${siteId}/collections`);
  return Array.isArray(resp?.collections) ? resp.collections : (Array.isArray(resp) ? resp : []);
}

// ---- Destructive guard ----
function assertMutationAllowed(req) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (!mutating) return;
  if (ALLOW_MUTATIONS !== 'true') throw new HttpError(403, 'Mutations disabled by server');
  if (REQUIRE_DESTRUCTIVE_HEADER === 'true') {
    const flag = (req.header('x-allow-destructive') || '').toLowerCase();
    if (!['true', 'yes', '1'].includes(flag)) {
      throw new HttpError(403, 'Missing x-allow-destructive header for mutating request');
    }
  }
}

// ---- Endpoints (existing) ----
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: SERVICE_NAME,
    env: NODE_ENV,
    time: new Date().toISOString(),
    defaults: {
      siteIdPresent: !!WEBFLOW_SITE_ID,
      articlesCollectionPresent: !!ARTICLES_COLLECTION_ID,
      resourcesCollectionPresent: !!RESOURCES_COLLECTION_ID,
    }
  });
});

app.get('/sse', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send('hello', { service: SERVICE_NAME, time: new Date().toISOString() });
  const interval = setInterval(() => send('heartbeat', { ts: Date.now() }), 25000);
  req.on('close', () => clearInterval(interval));
});

// Collections (SAFE by default; full=true uses site inventory)
app.get('/collections', asyncHandler(async (req, res) => {
  const full = (req.query.full === 'true');
  if (full) {
    const siteId = req.query.siteId || WEBFLOW_SITE_ID;
    if (!siteId) throw new HttpError(400, 'Missing siteId (and WEBFLOW_SITE_ID not set)');
    const collections = await listCollectionsForSite(siteId);
    return res.json({ status: 'ok', mode: 'full', siteId, count: collections.length, collections });
  }

  // Safe mode: just the env-mapped collections
  const ids = [ARTICLES_COLLECTION_ID, RESOURCES_COLLECTION_ID].filter(Boolean);
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const c = await wf('GET', `/collections/${id}`);
      return { id, name: c?.name || c?.displayName || 'Unknown', slug: c?.slug, ok: true };
    } catch (e) {
      return { id, name: 'Unknown (env)', ok: false, error: { status: e.status || 500, message: e.message, details: e.details } };
    }
  }));
  res.json({ status: 'ok', mode: 'safe', count: results.length, collections: results });
}));

// One collection
app.get('/collections/:idOrAlias', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const data = await wf('GET', `/collections/${collectionId}`);
  res.json({ status: 'ok', collection: data });
}));

// Items list
app.get('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { all, limit, offset } = req.query;
  if (all === 'true') {
    const items = await listAllItems(collectionId);
    return res.json({ status: 'ok', collectionId, total: items.length, items });
  }
  const l = Math.min(Number(limit || 100), 100);
  const o = Number(offset || 0);
  const data = await wf('GET', `/collections/${collectionId}/items`, { query: { limit: l, offset: o } });
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  res.json({ status: 'ok', collectionId, count: items.length, items });
}));

// Item get
app.get('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const item = await wf('GET', `/collections/${collectionId}/items/${req.params.itemId}`);
  res.json({ status: 'ok', collectionId, item });
}));

// Item create (v2: fieldData)
app.post('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  assertMutationAllowed(req);
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const body = req.body || {};
  let fieldData = toFieldDataShape(body);
  fieldData = normalizeDraftArchive(fieldData, body);
  const created = await wf('POST', `/collections/${collectionId}/items`, {
    body: { fieldData, isDraft: fieldData._draft, isArchived: fieldData._archived }
  });
  res.status(201).json({ status: 'ok', collectionId, created });
}));

// Item update (v2: fieldData)
app.patch('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  assertMutationAllowed(req);
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const itemId = req.params.itemId;
  const body = req.body || {};
  let fieldData = toFieldDataShape(body);
  fieldData = normalizeDraftArchive(fieldData, body);
  const updated = await wf('PATCH', `/collections/${collectionId}/items/${itemId}`, {
    body: { fieldData, isDraft: fieldData._draft, isArchived: fieldData._archived }
  });
  res.json({ status: 'ok', collectionId, itemId, updated });
}));

// Item delete
app.delete('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  assertMutationAllowed(req);
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const deleted = await wf('DELETE', `/collections/${collectionId}/items/${req.params.itemId}`);
  res.json({ status: 'ok', collectionId, itemId: req.params.itemId, deleted });
}));

// Publish (v2) — correct path: /items/publish
app.post('/collections/:idOrAlias/items/publish', asyncHandler(async (req, res) => {
  assertMutationAllowed(req);
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemIds = [], siteId } = req.body || {};
  const publishSiteId = siteId || WEBFLOW_SITE_ID;
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw new HttpError(400, 'itemIds[] required');
  const published = await wf('POST', `/collections/${collectionId}/items/publish`, {
    body: { itemIds, publishTo: publishSiteId ? [publishSiteId] : undefined }
  });
  res.json({ status: 'ok', collectionId, published });
}));

// Aliases (restored)
function aliasRoutes(alias, collectionId) {
  if (!collectionId) return;
  const forward = (method, path) =>
    app[method](`/collections/${alias}${path}`, (req, res, next) => {
      req.params.idOrAlias = collectionId; app._router.handle(req, res, next);
    });
  forward('get', '');
  forward('get', '/items');
  app.post(`/collections/${alias}/items`, (req, res, next) => { req.params.idOrAlias = collectionId; app._router.handle(req, res, next); });
  app.get(`/collections/${alias}/items/:itemId`, (req, res, next) => { req.params.idOrAlias = collectionId; app._router.handle(req, res, next); });
  app.patch(`/collections/${alias}/items/:itemId`, (req, res, next) => { req.params.idOrAlias = collectionId; app._router.handle(req, res, next); });
  app.delete(`/collections/${alias}/items/:itemId`, (req, res, next) => { req.params.idOrAlias = collectionId; app._router.handle(req, res, next); });
  app.post(`/collections/${alias}/items/publish`, (req, res, next) => { req.params.idOrAlias = collectionId; app._router.handle(req, res, next); });
}
aliasRoutes('articles', ARTICLES_COLLECTION_ID);
aliasRoutes('resources', RESOURCES_COLLECTION_ID);

// Audit (env safe mode by default; full=true for site)
app.get('/audit', asyncHandler(async (req, res) => {
  const full = (req.query.full === 'true');
  const siteId = req.query.siteId || WEBFLOW_SITE_ID;
  const doSmoke = (req.query.doSmoke ?? 'true') === 'true';
  const publish = (req.query.publish ?? 'false') === 'true';

  const report = {
    status: 'ok',
    mode: full ? 'full' : 'safe',
    startedAt: new Date().toISOString(),
    siteId: siteId || null,
    totals: { collections: 0, items: 0 },
    collections: [],
    smokeTest: null
  };

  let collections = [];
  try {
    if (full) {
      if (!siteId) throw new HttpError(400, 'Missing siteId (and WEBFLOW_SITE_ID not set)');
      collections = await listCollectionsForSite(siteId);
    } else {
      collections = []
        .concat(ARTICLES_COLLECTION_ID ? [{ id: ARTICLES_COLLECTION_ID, name: 'Articles (env)' }] : [])
        .concat(RESOURCES_COLLECTION_ID ? [{ id: RESOURCES_COLLECTION_ID, name: 'Resources (env)' }] : []);
    }
  } catch (e) {
    report.collectionsFetchError = { status: e.status || 500, message: e.message, details: e.details };
  }

  report.totals.collections = collections.length;

  for (const c of collections) {
    const cid = c.id || c._id || c.collectionId || c;
    const cname = c.name || c.displayName || c.slug || cid;
    let items = [];
    let colError = null;

    try { items = await listAllItems(cid); }
    catch (e) { colError = { status: e.status || 500, message: e.message, details: e.details }; }

    report.totals.items += items.length;

    const seenSlugs = new Map();
    const missingSlugs = [];
    const missingNames = [];
    const drafts = [];
    const archived = [];
    const dupSlugs = [];

    for (const it of items) {
      const id = it.id || it._id || it.itemId || it['id'];
      const slug = it?.slug ?? it?.fieldData?.slug;
      const name = it?.name ?? it?.fieldData?.name;
      const isDraft = it?.isDraft ?? it?.fieldData?._draft ?? it?._draft ?? false;
      const isArchived = it?.isArchived ?? it?.fieldData?._archived ?? it?._archived ?? false;

      if (!slug) missingSlugs.push(id);
      if (!name) missingNames.push(id);
      if (isDraft) drafts.push(id);
      if (isArchived) archived.push(id);

      if (slug) {
        if (!seenSlugs.has(slug)) seenSlugs.set(slug, []);
        seenSlugs.get(slug).push(id);
      }
    }
    for (const [slug, ids] of seenSlugs.entries()) {
      if (ids.length > 1) dupSlugs.push({ slug, itemIds: ids });
    }

    const patchSuggestions = [];
    const takeLast = (s, n) => String(s).slice(-n);
    for (const it of items) {
      const id = it.id || it._id || it.itemId || it['id'];
      const slug = it?.slug ?? it?.fieldData?.slug;
      const name = it?.name ?? it?.fieldData?.name;
      const changes = {};
      let needs = false;
      if (!slug) { changes.slug = `auto-${takeLast(id, 6)}`; needs = true; }
      else if (dupSlugs.find(d => d.itemIds.includes(id))) { changes.slug = `${slug}-${takeLast(id, 6)}`; needs = true; }
      if (!name) { changes.name = `Missing name ${takeLast(id, 6)}`; needs = true; }
      if (needs) {
        patchSuggestions.push({
          itemId: id,
          changes,
          patch: { fieldData: { ...changes, _draft: it?.fieldData?._draft ?? false, _archived: it?.fieldData?._archived ?? false } }
        });
      }
    }

    report.collections.push({
      id: cid,
      name: cname,
      error: colError,
      counts: {
        items: items.length,
        missingSlugs: missingSlugs.length,
        missingNames: missingNames.length,
        drafts: drafts.length,
        archived: archived.length,
        duplicateSlugGroups: dupSlugs.length
      },
      duplicateSlugs: dupSlugs,
      patchSuggestions
    });
  }

  // Smoke test (create → update → optional publish → delete)
  if (doSmoke) {
    // Require mutation approval for the smoke sequence
    assertMutationAllowed(req);

    const smoke = { startedAt: new Date().toISOString() };
    const targetCid = RESOURCES_COLLECTION_ID || ARTICLES_COLLECTION_ID || (report.collections[0]?.id);
    smoke.collectionId = targetCid;

    try {
      if (!targetCid) throw new HttpError(400, 'No collection id available for smoke test');

      const ts = Date.now();
      const slug = `mcp-smoke-${ts}`;
      const name = `MCP Smoke Test ${ts}`;

      const created = await wf('POST', `/collections/${targetCid}/items`, {
        body: { fieldData: { name, slug, _draft: true, _archived: false }, isDraft: true, isArchived: false }
      });
      const createdItemId =
        created?.id || created?._id || created?.item?._id || created?.item?.id || created?.itemId;

      smoke.created = { ok: true, itemId: createdItemId };

      await wf('PATCH', `/collections/${targetCid}/items/${createdItemId}`, {
        body: { fieldData: { name: `${name} (updated)`, _draft: true, _archived: false }, isDraft: true, isArchived: false }
      });
      smoke.updated = { ok: true };

      if (publish) {
        const pub = await wf('POST', `/collections/${targetCid}/items/publish`, {
          body: { itemIds: [createdItemId], publishTo: WEBFLOW_SITE_ID ? [WEBFLOW_SITE_ID] : undefined }
        });
        smoke.published = { ok: true, data: pub };
      }

      await wf('DELETE', `/collections/${targetCid}/items/${createdItemId}`);
      smoke.deleted = { ok: true };
      smoke.ok = true;
    } catch (e) {
      smoke.ok = false;
      smoke.error = { status: e.status || 500, message: e.message, details: e.details };
    }

    report.smokeTest = smoke;
  }

  report.finishedAt = new Date().toISOString();
  res.json(report);
}));

// ---- New: Generic pass-through for Webflow Data API (allow-listed bases) ----
const PASSTHRU_BASES = [
  'sites', 'pages', 'components',
  'collections', // extends your custom routes
  'forms', 'form-submissions',
  'custom-code', 'assets', 'asset-folders',
  'comments', 'users', 'access-groups',
  'products', 'orders', 'inventory', 'settings',
  'webhooks',
  'workspace', 'redirects', 'robots', 'well-known'
];
for (const base of PASSTHRU_BASES) {
  const handler = asyncHandler(async (req, res) => {
    assertMutationAllowed(req);
    const suffix = req.params[0] ? `/${req.params[0]}` : '';
    const data = await wf(req.method, `/${base}${suffix}`, { query: req.query, body: (req.body && Object.keys(req.body).length) ? req.body : undefined });
    res.json({ status: 'ok', base, data });
  });
  app.all(`/${base}`, handler);
  app.all(`/${base}/*`, handler);
}

// ---- New: Asset upload helper (Base64 → multipart) ----
app.post('/assets/upload-base64', asyncHandler(async (req, res) => {
  assertMutationAllowed(req);
  const { siteId = WEBFLOW_SITE_ID, folderId, fileName, fileBase64 } = req.body || {};
  if (!siteId) throw new HttpError(400, 'siteId required');
  if (!fileName || !fileBase64) throw new HttpError(400, 'fileName and fileBase64 required');

  const buf = Buffer.from(fileBase64, 'base64');
  const form = new FormData();
  const blob = new Blob([buf]);
  form.append('file', blob, fileName);
  if (folderId) form.append('folderId', folderId);

  const data = await wf('POST', `/sites/${siteId}/assets`, { body: form });
  res.status(201).json({ status: 'ok', asset: data });
}));

// ---- New: Boot-time scope sanity check ----
async function checkScopesOnBoot() {
  const checks = [
    { path: '/sites', scope: 'Sites:Read' },
    { path: `/sites/${WEBFLOW_SITE_ID}/collections`, scope: 'CMS:Read' },
    { path: `/sites/${WEBFLOW_SITE_ID}/assets`, scope: 'Assets:Read' },
    { path: '/webhooks', scope: 'Webhooks:Read' },
    { path: `/sites/${WEBFLOW_SITE_ID}/users`, scope: 'Users:Read' },
    { path: `/sites/${WEBFLOW_SITE_ID}/products`, scope: 'Ecommerce:Read' },
  ];
  for (const { path, scope } of checks) {
    try {
      await wf('GET', path);
    } catch (e) {
      console.warn(`[${SERVICE_NAME}] Scope check failed for ${path} (${e.status}) — add ${scope}`);
    }
  }
}

// ---- Not found ----
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Not Found', details: { path: req.path } });
});

// ---- Error handler ----
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  const message = err.message || 'Internal Server Error';
  const details = (err instanceof HttpError) ? err.details : (err.details || undefined);
  console.error(
    `[${SERVICE_NAME}] Error ${status} on ${req.method} ${req.path}: ${message}`,
    details ? JSON.stringify(details) : ''
  );
  res.status(status).json({ status: 'error', message, details });
});

// ---- Start ----
if (require.main === module) {
  checkScopesOnBoot().catch(() => {});
  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on ${PORT}`);
  });
}
module.exports = app;
