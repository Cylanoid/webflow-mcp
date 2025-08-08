'use strict';

/**
 * Webflow MCP Connector
 * - Strict 401 via x-api-token if CONNECTOR_API_TOKEN is set
 * - Defaults to WEBFLOW_SITE_ID
 * - Aliases for Articles/Resources collections via env IDs
 * - Clean JSON errors
 * - SSE heartbeat at /sse
 * - /health, /sites, /collections, item CRUD, publish
 * - /audit: inventory, checks, suggestions, safe smoke test
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
const WF_ACCEPT_VERSION = '1.0.0';

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

// ---- Webflow HTTP client ----
async function wf(method, path, { query, body } = {}) {
  if (!WEBFLOW_API_KEY) {
    throw new HttpError(500, 'WEBFLOW_API_KEY is not configured');
  }
  const url = new URL(WF_API_BASE + path);
  if (query) {
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
    const msg = (data && (data.err || data.message)) || `Webflow API error ${res.status}`;
    throw new HttpError(res.status, msg, { path, data });
  }
  return data;
}

const resolveCollectionId = (idOrAlias) => {
  const low = String(idOrAlias).toLowerCase();
  if (low === 'articles') return ARTICLES_COLLECTION_ID;
  if (low === 'resources') return RESOURCES_COLLECTION_ID;
  return idOrAlias;
};

function normalizeItemPayload(input) {
  const source = input || {};
  let fieldData = {};
  if (source.fieldData) {
    fieldData = { ...source.fieldData };
  } else {
    for (const [k, v] of Object.entries(source)) {
      if (k !== 'fieldData') fieldData[k] = v;
    }
  }
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
    const pageItems = page?.items || [];
    items.push(...pageItems);
    if (pageItems.length < pageSize) break;
    offset += pageSize;
  }
  return items;
}

// ---- Endpoints ----
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
  const interval = setInterval(() => {
    send('heartbeat', { ts: Date.now() });
  }, 25000);
  req.on('close', () => clearInterval(interval));
});

app.get('/sites', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/sites');
  res.json({ status: 'ok', data });
}));

app.get('/collections', asyncHandler(async (req, res) => {
  const siteId = req.query.siteId || WEBFLOW_SITE_ID;
  const data = await wf('GET', `/sites/${siteId}/collections`);
  res.json({ status: 'ok', siteId, collections: data.collections || data });
}));

app.get('/collections/:idOrAlias', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const data = await wf('GET', `/collections/${collectionId}`);
  res.json({ status: 'ok', collection: data });
}));

app.get('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  if (req.query.all === 'true') {
    const items = await listAllItems(collectionId);
    return res.json({ status: 'ok', items });
  }
  const data = await wf('GET', `/collections/${collectionId}/items`, { query: req.query });
  res.json({ status: 'ok', items: data.items || data });
}));

app.post('/collections/:idOrAlias/items', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const payload = normalizeItemPayload(req.body || {});
  const created = await wf('POST', `/collections/${collectionId}/items`, { body: payload });
  res.status(201).json({ status: 'ok', created });
}));

app.patch('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const payload = normalizeItemPayload(req.body || {});
  const updated = await wf('PATCH', `/collections/${collectionId}/items/${req.params.itemId}`, { body: payload });
  res.json({ status: 'ok', updated });
}));

app.delete('/collections/:idOrAlias/items/:itemId', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const deleted = await wf('DELETE', `/collections/${collectionId}/items/${req.params.itemId}`);
  res.json({ status: 'ok', deleted });
}));

app.post('/collections/:idOrAlias/items/publish', asyncHandler(async (req, res) => {
  const collectionId = resolveCollectionId(req.params.idOrAlias);
  const { itemIds = [], siteId } = req.body || {};
  const publishSiteId = siteId || WEBFLOW_SITE_ID;
  if (!itemIds.length) throw new HttpError(400, 'itemIds[] required');
  const published = await wf('POST', `/collections/${collectionId}/items/publish`, {
    body: { itemIds, publishTo: publishSiteId ? [publishSiteId] : undefined }
  });
  res.json({ status: 'ok', published });
}));

// ---- /audit ----
app.get('/audit', asyncHandler(async (req, res) => {
  const siteId = req.query.siteId || WEBFLOW_SITE_ID;
  const doSmoke = (req.query.doSmoke ?? 'true') === 'true';
  const publish = (req.query.publish ?? 'false') === 'true';
  const colResp = await wf('GET', `/sites/${siteId}/collections`);
  const collections = colResp.collections || colResp || [];
  const report = {
    status: 'ok',
    siteId,
    totals: { collections: collections.length, items: 0 },
    collections: [],
    smokeTest: null
  };
  for (const c of collections) {
    const cid = c.id || c._id || c;
    let items = [];
    try { items = await listAllItems(cid); } catch {}
    report.totals.items += items.length;
    report.collections.push({
      id: cid,
      name: c.name || cid,
      counts: { items: items.length }
    });
  }
  if (doSmoke) {
    const targetCid = RESOURCES_COLLECTION_ID || ARTICLES_COLLECTION_ID;
    const ts = Date.now();
    const slug = `mcp-smoke-${ts}`;
    const name = `MCP Smoke Test ${ts}`;
    try {
      const created = await wf('POST', `/collections/${targetCid}/items`, {
        body: { fieldData: { name, slug, _draft: true } }
      });
      const id = created.id || created._id;
      await wf('PATCH', `/collections/${targetCid}/items/${id}`, {
        body: { fieldData: { name: `${name} updated`, _draft: true } }
      });
      if (publish) {
        await wf('POST', `/collections/${targetCid}/items/publish`, {
          body: { itemIds: [id], publishTo: [WEBFLOW_SITE_ID] }
        });
      }
      await wf('DELETE', `/collections/${targetCid}/items/${id}`);
      report.smokeTest = { ok: true, collectionId: targetCid };
    } catch (e) {
      report.smokeTest = { ok: false, error: e.message };
    }
  }
  res.json(report);
}));

// ---- Error handling ----
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Not Found' });
});
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ status: 'error', message: err.message, details: err.details });
});

// ---- Start ----
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on ${PORT}`);
  });
}
module.exports = app;
