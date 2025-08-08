'use strict';

/**
 * Webflow MCP Connector – SAFE MODE by default
 * - Auth gate: requires x-api-token if CONNECTOR_API_TOKEN is set
 * - Health, SSE (/sse)
 * - Collections & Audit:
 *    * Default SAFE mode: use only env-mapped collections (no /sites calls)
 *    * full=true: enable site-level inventory with v2 endpoints
 * - Items CRUD, publish
 * - Clean JSON errors
 * - Auto Webflow version fallback: 1.1.0 → 1.0.0 on UnsupportedVersion
 * - Auto payload fallback for items: fieldData → fields when v1 requires it
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
} = process.env;

const SERVICE_NAME = 'webflow-mcp';
const WF_API_BASE = 'https://api.webflow.com';
const WF_VERSION_PRIMARY = '1.1.0'; // v2-capable (/sites ...)
const WF_VERSION_LEGACY  = '1.0.0'; // v1-only (/collections/{id}/items ...)
console.log(`[${SERVICE_NAME}] Webflow API primary: ${WF_VERSION_PRIMARY}, legacy: ${WF_VERSION_LEGACY}`);

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

// ---- Gate: 401 if CONNECTOR_API_TOKEN set ----
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

// ---- Webflow HTTP client with auto-fallback ----
async function wfOnce(method, path, version, { query, body } = {}) {
  if (!WEBFLOW_API_KEY) throw new HttpError(500, 'WEBFLOW_API_KEY is not configured');

  const url = new URL(WF_API_BASE + path);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }

  // FIX 1: Conditionally set Content-Type header only when body is present.
  const headers = {
    'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
    'accept-version': version,
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.err || data?.message || data?.msg || `Webflow API error ${res.status}`;
    throw new HttpError(res.status, msg, { path, data, status: res.status, versionUsed: version });
  }
  return data;
}

async function wf(method, path, opts = {}) {
  try {
    return await wfOnce(method, path, WF_VERSION_PRIMARY, opts);
  } catch (e) {
    const name = e?.details?.data?.name || '';
    const msg  = e?.details?.data?.msg  || e.message || '';
    const isUnsupported = e.status === 400 && (name === 'UnsupportedVersion' || /UnsupportedVersion|Valid ranges include:\s*1\.0\.0/i.test(msg));
    if (isUnsupported) {
      // Retry once with legacy 1.0.0 for v1-only endpoints
      return await wfOnce(method, path, WF_VERSION_LEGACY, opts);
    }
    throw e;
  }
}

// ---- Helpers ----

// FIX 2 / Refactor: Centralized helper for Item Writes (Create/Update) with payload fallback
async function wfWriteItem(method, path, fieldData) {
    try {
        // Try V2 (fieldData). wf() handles version fallback.
        const result = await wf(method, path, { body: { fieldData } });
        return { result, usedV1Fields: false };
    } catch (e) {
        // Check if the error specifically requires V1 payload (fields)
        const msg = e?.details?.data?.msg || e.message || '';
        const needFields = e.status === 400 && (/\'fields\' is required/i.test(msg) || /fields is required/i.test(msg));
        if (!needFields) throw e;

        // Fallback V1 (fields)
        const result = await wf(method, path, { body: { fields: fieldData } });
        return { result, usedV1Fields: true };
    }
}


const resolveCollectionId = (idOrAlias) => {
  if (!idOrAlias) return idOrAlias;
  const low = String(idOrAlias).toLowerCase();
  if (low === 'articles') return ARTICLES_COLLECTION_ID;
  if (low === 'resources') return RESOURCES_COLLECTION_ID;
  return idOrAlias;
};

function toFieldDataShape(body) {
  const src = body || {};
  if (src.fieldData && typeof src.fieldData === 'object') {
    return { ...src.fieldData };
  }
  const fd = {};
  for (const [k, v] of Object.entries(src)) {
    if (k !== 'fieldData') fd[k] = v;
  }
  return fd;
}

function normalizeDraftArchive(fd, src) {
  const out = { ...fd };
  if (out._draft === undefined) {
    if (src?.isDraft !== undefined) out._draft = !!src.isDraft;
    else if (src?._draft !== undefined) out._draft = !!src._draft;
    else out._draft = false;
  }
  if (out._archived === undefined) {
    if (src?.isArchived !== undefined) out._archived = !!src.isArchived;
    else if (src?._archived !== undefined) out._archived = !!src._archived;
    else out._archived = false;
  }
  return out;
}

async function listAllItems(collectionId, pageSize = 100) {
  const items = [];
  let offset = 0;
  while (true) {
    const page = await wf('GET', `/collections/${collectionId}/items`, {
      query: { offset, limit: pageSize }
    });
    const pageItems = Array.isArray(page?.items) ? page.items : (Array.isArray(page) ? page : []);
    items.push(...pageItems);
    if (pageItems.length < pageSize) break;
    offset += pageSize;
  }
  return items;
}

// v2 site listing (only when full=true)
async function listCollectionsForSite(siteId) {
  try {
    const resp = await wf('GET', `/sites/${siteId}/collections`);
    const arr = Array.isArray(resp?.collections) ? resp.collections : (Array.isArray(resp) ? resp : []);
    if (arr) return arr;
  } catch (e) {
    if (e.status && e.status !== 400) throw e;
  }
  const fb = await wf('GET', `/collections`, { query: { siteId } });
  const arr = Array.isArray(fb?.collections) ? fb.collections : (Array.isArray(fb) ? fb : []);
  return arr;
}

// ---- Core Endpoints ----
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

// ---- Collections (SAFE by default) ----
app.get('/collections', asyncHandler(async (req, res) => {
  const full = (req.query.full === 'true');
  if (full) {
    const siteId = req.query.siteId || WEBFLOW_SITE_ID;
    if (!siteId) throw new HttpError(400, 'Missing siteId (and WEBFLOW_SITE_ID not set)');
    const collections = await listCollectionsForSite(siteId);
    return res.json({ status: 'ok', mode: 'full', siteId, count: collections.length, collections });
  }

  // SAFE mode: env-only collections
  const ids = [ARTICLES_COLLECTION_ID, RESOURCES_COLLECTION_ID].filter(Boolean);
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const c = await wf('GET', `/collections/${id}`);
      return { id, name: c?.name || c?.displayName || 'Unknown', slug: c?.slug, ok: true };
    } catch (e) {
      // Added details to error response for better debugging if issues persist
      return { id, name: 'Unknown (env)', ok: false, error: { status: e.status || 500, message: e.message, details: e.details } };
    }
  }));
  res.json({ status: 'ok', mode: 'safe', count: results.length, collections: results });
}));

// Single collection metadata
app.get('/collections/:idOrAlias', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const data = await wf('GET', `/collections/${collectionId}`);
  res.json({ status: 'ok', collection: data });
}));

// ---- Items LIST/GET ----
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

app.get('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const item = await wf('GET', `/collections/${collectionId}/items/${req.params.itemId}`);
  res.json({ status: 'ok', collectionId, item });
}));

// ---- Items CREATE (Refactored to use wfWriteItem) ----
app.post('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const body = req.body || {};
  let fieldData = toFieldDataShape(body);
  fieldData = normalizeDraftArchive(fieldData, body);

  // Use the centralized helper
  const { result: created, usedV1Fields } = await wfWriteItem('POST', `/collections/${collectionId}/items`, fieldData);
  const response = { status: 'ok', collectionId, created };
  if (usedV1Fields) response.note = 'v1 fields payload';
  return res.status(201).json(response);
}));

// ---- Items UPDATE (Refactored to use wfWriteItem) ----
app.patch('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const itemId = req.params.itemId;
  const body = req.body || {};
  let fieldData = toFieldDataShape(body);
  fieldData = normalizeDraftArchive(fieldData, body);

  // Use the centralized helper
  const { result: updated, usedV1Fields } = await wfWriteItem('PATCH', `/collections/${collectionId}/items/${itemId}`, fieldData);
  const response = { status: 'ok', collectionId, itemId, updated };
  if (usedV1Fields) response.note = 'v1 fields payload';
  return res.json(response);
}));

// ---- Items DELETE ----
app.delete('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const deleted = await wf('DELETE', `/collections/${collectionId}/items/${req.params.itemId}`);
  res.json({ status: 'ok', collectionId, itemId: req.params.itemId, deleted });
}));

// ---- Items PUBLISH ----
app.post('/collections/:idOrAlias/items/publish', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemIds = [], siteId } = req.body || {};
  const publishSiteId = siteId || WEBFLOW_SITE_ID;
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw new HttpError(400, 'itemIds[] required');
  try {
    // V2 Publish
    const published = await wf('POST', `/collections/${collectionId}/items/publish`, {
      body: { itemIds, publishTo: publishSiteId ? [publishSiteId] : undefined }
    });
    return res.json({ status: 'ok', collectionId, published });
  } catch (e) {
    if (e.status && e.status !== 400) throw e;
    // V1 Publish Fallback
    const published = await wf('POST', `/collections/${collectionId}/items/publish`, {
      body: { itemIds, live: true }
    });
    return res.json({ status: 'ok', collectionId, published, note: 'legacy publish fallback' });
  }
}));

// ---- Aliases ----
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

// ---- Audit (SAFE by default; full=true to use site) ----
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
    // Added details to error response
    catch (e) { colError = { status: e.status || 500, message: e.message, details: e.details }; }

    report.totals.items += items.length;

    // Basic checks
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
    // FIX 2: Ensure smoke test handles payload fallbacks
    const smoke = { startedAt: new Date().toISOString(), notes: [] };
    const targetCid = RESOURCES_COLLECTION_ID || ARTICLES_COLLECTION_ID || (report.collections[0]?.id);
    smoke.collectionId = targetCid;
    let createdItemId = null; // Track for cleanup

    try {
      if (!targetCid) throw new HttpError(400, 'No collection id available for smoke test');

      const ts = Date.now();
      const slug = `mcp-smoke-${ts}`;
      const name = `MCP Smoke Test ${ts}`;

      // Use helper for Create
      const createPayload = { name, slug, _draft: true, _archived: false };
      const { result: created, usedV1Fields: createUsedV1 } = await wfWriteItem('POST', `/collections/${targetCid}/items`, createPayload);
      if (createUsedV1) smoke.notes.push('v1 fields payload used for create');

      createdItemId =
        created?.id || created?._id || created?.item?._id || created?.item?.id || created?.itemId;

      if (!createdItemId) {
        throw new HttpError(500, 'Failed to retrieve itemId after creation', { created });
      }

      smoke.created = { ok: true, itemId: createdItemId };

      // Use helper for Update
      const updatePayload = { name: `${name} (updated)`, _draft: true, _archived: false };
      const { usedV1Fields: updateUsedV1 } = await wfWriteItem('PATCH', `/collections/${targetCid}/items/${createdItemId}`, updatePayload);
      if (updateUsedV1) smoke.notes.push('v1 fields payload used for update');

      smoke.updated = { ok: true };

      if (publish) {
        try {
          // Ensure publish fallback is handled explicitly
          let pub;
          try {
            // V2 Publish
            pub = await wf('POST', `/collections/${targetCid}/items/publish`, {
              body: { itemIds: [createdItemId], publishTo: WEBFLOW_SITE_ID ? [WEBFLOW_SITE_ID] : undefined }
            });
          } catch (e) {
            if (e.status && e.status !== 400) throw e;
            // V1 Publish Fallback
            pub = await wf('POST', `/collections/${targetCid}/items/publish`, {
                body: { itemIds: [createdItemId], live: true }
            });
            smoke.notes.push('legacy publish fallback used');
          }
          smoke.published = { ok: true, data: pub };
        } catch (e) {
          smoke.published = { ok: false, status: e.status || 500, message: e.message };
        }
      }

      // Delete
      await wf('DELETE', `/collections/${targetCid}/items/${createdItemId}`);
      smoke.deleted = { ok: true };
      smoke.ok = true;
      if (smoke.notes.length === 0) delete smoke.notes; // Cleanup empty notes
    } catch (e) {
      smoke.ok = false;
      smoke.error = { status: e.status || 500, message: e.message, details: e.details };
    }

    report.smokeTest = smoke;
  }

  report.finishedAt = new Date().toISOString();
  res.json(report);
}));

// ---- Not found ----
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Not Found', details: { path: req.path } });
});

// ---- Error handler ----
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  const message = err.message || 'Internal Server Error';
  const details = (err instanceof HttpError) ? err.details : (err.details || undefined);
  // Added server-side logging
  console.error(`[${SERVICE_NAME}] Error ${status} on ${req.method} ${req.path}: ${message}`, details ? JSON.stringify(details) : '');
  res.status(status).json({ status: 'error', message, details });
});

// ---- Start ----
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on ${PORT}`);
  });
}
module.exports = app;
