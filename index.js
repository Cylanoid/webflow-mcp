'use strict';

/**
 * Webflow MCP Connector
 * - Hard-gated by CONNECTOR_API_TOKEN via x-api-token header (strict 401)
 * - Defaults to WEBFLOW_SITE_ID
 * - Collections convenience aliases for Articles/Resources via env IDs
 * - Clean JSON errors
 * - SSE heartbeat at /sse
 * - Robust /health
 * - CMS CRUD + publish
 * - /audit to inventory, validate, suggest patches, and run a safe smoke test
 *
 * No secrets are logged. WEBFLOW_API_KEY must be provided only via env.
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
const WF_ACCEPT_VERSION = '1.0.0'; // Keep broad compatibility

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
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// ---- Gate: strict 401 when CONNECTOR_API_TOKEN is set ----
app.use((req, res, next) => {
  const expected = CONNECTOR_API_TOKEN;
  if (expected && !safeCompare(req.header('x-api-token') || '', expected)) {
    return res
      .status(401)
      .json({ status: 'error', message: 'Unauthorized', details: { code: 'MISSING_OR_INVALID_API_TOKEN' } });
  }
  next();
});

// ---- Webflow HTTP client (uses built-in fetch in Node >=18) ----
async function wf(method, path, { query, body } = {}) {
  if (!WEBFLOW_API_KEY) {
    throw new HttpError(500, 'WEBFLOW_API_KEY is not configured');
  }
  const url = new URL(WF_API_BASE + path);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
      'accept-version': WF_ACCEPT_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = (data && (data.err || data.message)) ? (data.err || data.message) : `Webflow API error ${res.status}`;
    throw new HttpError(res.status, msg, { path, data });
  }
  return data;
}

const resolveCollectionId = (idOrAlias) => {
  if (!idOrAlias) return null;
  const low = String(idOrAlias).toLowerCase();
  if (low === 'articles') return ARTICLES_COLLECTION_ID;
  if (low === 'resources') return RESOURCES_COLLECTION_ID;
  return idOrAlias; // assume raw ID
};

const getSlugFromItem = (item) => {
  // Try multiple shapes to be resilient to API versions
  return item?.slug ?? item?.fieldData?.slug ?? item?.fieldData?.['slug'] ?? undefined;
};

const getNameFromItem = (item) => {
  return item?.name ?? item?.fieldData?.name ?? item?.fieldData?.['name'] ?? undefined;
};

function normalizeItemPayload(input) {
  // Accepts either { fieldData: {...} } or flat keys (name, slug, etc.)
  const source = input || {};
  let fieldData = {};
  if (source.fieldData && typeof source.fieldData === 'object') {
    fieldData = { ...source.fieldData };
  } else {
    // copy all top-level fields as fieldData except known meta keys
    const omit = new Set(['fieldData']);
    for (const [k, v] of Object.entries(source)) {
      if (!omit.has(k)) fieldData[k] = v;
    }
  }

  // Normalize draft/archived flags to Webflow v2 keys in fieldData
  if (source._draft !== undefined) fieldData._draft = !!source._draft;
  if (source._archived !== undefined) fieldData._archived = !!source._archived;
  if (source.isDraft !== undefined) fieldData._draft = !!source.isDraft;
  if (source.isArchived !== undefined) fieldData._archived = !!source.isArchived;

  if (fieldData._draft === undefined) fieldData._draft = false;
  if (fieldData._archived === undefined) fieldData._archived = false;

  return { fieldData };
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

// ---- Health ----
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: SERVICE_NAME,
    env: NODE_ENV,
    time: new Date().toISOString(),
    defaults: {
      siteIdPresent: Boolean(WEBFLOW_SITE_ID),
      articlesCollectionPresent: Boolean(ARTICLES_COLLECTION_ID),
      resourcesCollectionPresent: Boolean(RESOURCES_COLLECTION_ID),
    }
  });
});

// ---- SSE heartbeat (MCP-style) ----
app.get('/sse', (req, res) => {
  // Note: browser EventSource cannot set custom headers; this route is still gated by design.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { service: SERVICE_NAME, time: new Date().toISOString() });
  const interval = setInterval(() => {
    send('heartbeat', { ts: Date.now() });
  }, 25000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ---- Optional Sites ----
app.get('/sites', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/sites');
  res.json({ status: 'ok', count: Array.isArray(data?.sites) ? data.sites.length : (Array.isArray(data) ? data.length : undefined), data });
}));

// ---- Collections (default site) ----
app.get('/collections', asyncHandler(async (req, res) => {
  const siteId = req.query.siteId || WEBFLOW_SITE_ID;
  if (!siteId) throw new HttpError(400, 'Missing siteId (and WEBFLOW_SITE_ID not set)');
  const data = await wf('GET', `/sites/${siteId}/collections`);
  const arr = Array.isArray(data?.collections) ? data.collections : (Array.isArray(data) ? data : []);
  res.json({ status: 'ok', siteId, count: arr.length, collections: arr });
}));

app.get('/collections/:idOrAlias', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const data = await wf('GET', `/collections/${collectionId}`);
  res.json({ status: 'ok', collection: data });
}));

// ---- Items CRUD ----
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
  const { itemId } = req.params;
  const item = await wf('GET', `/collections/${collectionId}/items/${itemId}`);
  res.json({ status: 'ok', collectionId, item });
}));

app.post('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const payload = normalizeItemPayload(req.body || {});
  const created = await wf('POST', `/collections/${collectionId}/items`, { body: payload });
  res.status(201).json({ status: 'ok', collectionId, created });
}));

app.patch('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemId } = req.params;
  const payload = normalizeItemPayload(req.body || {});
  const updated = await wf('PATCH', `/collections/${collectionId}/items/${itemId}`, { body: payload });
  res.json({ status: 'ok', collectionId, itemId, updated });
}));

app.delete('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemId } = req.params;
  const deleted = await wf('DELETE', `/collections/${collectionId}/items/${itemId}`);
  res.json({ status: 'ok', collectionId, itemId, deleted });
}));

// ---- Publish items ----
app.post('/collections/:idOrAlias/items/publish', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemIds = [], siteId } = req.body || {};
  const publishSiteId = siteId || WEBFLOW_SITE_ID;
  if (!Array.isArray(itemIds) || itemIds.length === 0) throw new HttpError(400, 'itemIds[] required');

  // Attempt v2 body with explicit site
  let published;
  try {
    published = await wf('POST', `/collections/${collectionId}/items/publish`, {
      body: { itemIds, publishTo: publishSiteId ? [publishSiteId] : undefined }
    });
  } catch (e) {
    // Fallback to legacy live flag if needed
    if (e.status && e.status !== 400) throw e;
    published = await wf('POST', `/collections/${collectionId}/items/publish`, {
      body: { itemIds, live: true }
    });
  }
  res.json({ status: 'ok', collectionId, published });
}));

// ---- Convenience aliases ----
function aliasRoutes(alias, collectionId) {
  if (!collectionId) return;
  app.get(`/collections/${alias}/items`, (req, res, next) => {
    req.params.idOrAlias = collectionId;
    return app._router.handle(req, res, next);
  });
  app.post(`/collections/${alias}/items`, (req, res, next) => {
    req.params.idOrAlias = collectionId;
    return app._router.handle(req, res, next);
  });
  app.get(`/collections/${alias}`, (req, res, next) => {
    req.params.idOrAlias = collectionId;
    return app._router.handle(req, res, next);
  });
}
aliasRoutes('articles', ARTICLES_COLLECTION_ID);
aliasRoutes('resources', RESOURCES_COLLECTION_ID);

// ---- Audit ----
app.get('/audit', asyncHandler(async (req, res) => {
  const siteId = req.query.siteId || WEBFLOW_SITE_ID;
  const doSmoke = (req.query.doSmoke ?? 'true') === 'true';
  const publish = (req.query.publish ?? 'false') === 'true'; // optional publish of smoke item
  if (!siteId) throw new HttpError(400, 'Missing siteId (and WEBFLOW_SITE_ID not set)');

  // Inventory: collections for site
  const colResp = await wf('GET', `/sites/${siteId}/collections`);
  const collections = Array.isArray(colResp?.collections) ? colResp.collections :
                      (Array.isArray(colResp) ? colResp : []);
  const report = {
    status: 'ok',
    startedAt: new Date().toISOString(),
    siteId,
    totals: { collections: collections.length, items: 0 },
    collections: [],
    smokeTest: null
  };

  // Scan each collection
  for (const c of collections) {
    const cid = c.id || c._id || c.collectionId || c.databaseId || c;
    const cname = c.displayName || c.name || c.slug || cid;
    let items = [];
    try {
      items = await listAllItems(cid);
    } catch (e) {
      report.collections.push({
        id: cid, name: cname, error: { status: e.status || 500, message: e.message }
      });
      continue;
    }

    report.totals.items += items.length;

    const seenSlugs = new Map();
    const missingSlugs = [];
    const missingNames = [];
    const drafts = [];
    const archived = [];
    const dupSlugs = []; // list of {slug, itemIds[]}

    for (const it of items) {
      const id = it.id || it._id || it.itemId || it['id'];
      const slug = getSlugFromItem(it);
      const name = getNameFromItem(it);
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

    // Suggestions: minimal, safe patch payloads for missing/dup slugs & missing names
    const patchSuggestions = [];
    const takeLast = (s, n) => String(s).slice(-n);

    for (const it of items) {
      const id = it.id || it._id || it.itemId || it['id'];
      const slug = getSlugFromItem(it);
      const name = getNameFromItem(it);

      const changes = {};
      let needsPatch = false;

      if (!slug) {
        changes.slug = `auto-${takeLast(id, 6)}`;
        needsPatch = true;
      } else if ((dupSlugs.find(d => d.itemIds.includes(id)))) {
        changes.slug = `${slug}-${takeLast(id, 6)}`;
        needsPatch = true;
      }

      if (!name) {
        changes.name = `Missing name ${takeLast(id, 6)}`;
        needsPatch = true;
      }

      if (needsPatch) {
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

  // Smoke test (safe draft create→update→optional publish→delete) on Resources by default
  if (doSmoke) {
    const smoke = { startedAt: new Date().toISOString() };
    const targetCid = RESOURCES_COLLECTION_ID || ARTICLES_COLLECTION_ID || (report.collections[0]?.id);
    smoke.collectionId = targetCid;

    try {
      const ts = Date.now();
      const slug = `mcp-smoke-${ts}`;
      const name = `MCP Smoke Test ${ts}`;

      // create (draft)
      const created = await wf('POST', `/collections/${targetCid}/items`, {
        body: { fieldData: { name, slug, _draft: true, _archived: false } }
      });
      const createdItemId =
        created?.id || created?._id || created?.item?._id || created?.item?.id || created?.itemId;

      smoke.created = { ok: true, itemId: createdItemId };

      // update
      const updated = await wf('PATCH', `/collections/${targetCid}/items/${createdItemId}`, {
        body: { fieldData: { name: `${name} (updated)`, _draft: true, _archived: false } }
      });
      smoke.updated = { ok: true };

      // optional publish
      if (publish) {
        try {
          const pub = await wf('POST', `/collections/${targetCid}/items/publish`, {
            body: { itemIds: [createdItemId], publishTo: WEBFLOW_SITE_ID ? [WEBFLOW_SITE_ID] : undefined }
          });
          smoke.published = { ok: true, data: pub };
        } catch (e) {
          smoke.published = { ok: false, status: e.status || 500, message: e.message };
        }
      }

      // delete
      const del = await wf('DELETE', `/collections/${targetCid}/items/${createdItemId}`);
      smoke.deleted = { ok: true, data: del };
      smoke.ok = true;
    } catch (e) {
      smoke.ok = false;
      smoke.error = { status: e.status || 500, message: e.message };
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
  res.status(status).json({ status: 'error', message, details });
});

// ---- Start ----
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on ${PORT}`);
  });
}

module.exports = app;
