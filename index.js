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

  // Smoke test (create → update → optional publish → delete; fixed publish path)
  if (doSmoke) {
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
        const pub = await wf('POST', `/collections/${targetCid}/publish`, {
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

// ---- New: Token/Authorization ----
app.get('/auth/user', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/token/authorized_by');
  res.json({ status: 'ok', user: data });
}));

app.get('/auth/info', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/token/introspect');
  res.json({ status: 'ok', info: data });
}));

// ---- New: Sites ----
app.get('/sites', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/sites');
  res.json({ status: 'ok', sites: data });
}));

app.get('/sites/:siteId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}`);
  res.json({ status: 'ok', site: data });
}));

app.get('/sites/:siteId/domains', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/domains`);
  res.json({ status: 'ok', domains: data });
}));

app.post('/sites/:siteId/publish', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/publish`, { body: req.body });
  res.json({ status: 'ok', published: data });
}));

app.post('/sites', asyncHandler(async (req, res) => {
  const data = await wf('POST', '/sites', { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.patch('/sites/:siteId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/sites/${req.params.siteId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/sites/:siteId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/sites/${req.params.siteId}`);
  res.json({ status: 'ok', deleted: data });
}));

app.get('/sites/:siteId/plan', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/plan`);
  res.json({ status: 'ok', plan: data });
}));

// ---- New: Pages and Components ----
app.get('/sites/:siteId/pages', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/pages`);
  res.json({ status: 'ok', pages: data });
}));

app.get('/pages/:pageId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/pages/${req.params.pageId}`);
  res.json({ status: 'ok', page: data });
}));

app.put('/pages/:pageId', asyncHandler(async (req, res) => {
  const data = await wf('PUT', `/pages/${req.params.pageId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.get('/pages/:pageId/content', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/pages/${req.params.pageId}/content`);
  res.json({ status: 'ok', content: data });
}));

app.post('/pages/:pageId/content', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/pages/${req.params.pageId}/content`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.get('/sites/:siteId/components', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/components`);
  res.json({ status: 'ok', components: data });
}));

app.get('/components/:componentId/content', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/components/${req.params.componentId}/content`);
  res.json({ status: 'ok', content: data });
}));

app.post('/components/:componentId/content', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/components/${req.params.componentId}/content`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.get('/components/:componentId/properties', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/components/${req.params.componentId}/properties`);
  res.json({ status: 'ok', properties: data });
}));

app.post('/components/:componentId/properties', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/components/${req.params.componentId}/properties`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

// ---- New: CMS Extensions (create/delete collections, fields) ----
app.post('/sites/:siteId/collections', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/collections`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.delete('/collections/:collectionId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/collections/${req.params.collectionId}`);
  res.json({ status: 'ok', deleted: data });
}));

app.post('/collections/:collectionId/fields', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/collections/${req.params.collectionId}/fields`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.patch('/collections/:collectionId/fields/:fieldId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/collections/${req.params.collectionId}/fields/${req.params.fieldId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/collections/:collectionId/fields/:fieldId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/collections/${req.params.collectionId}/fields/${req.params.fieldId}`);
  res.json({ status: 'ok', deleted: data });
}));

// ---- New: Forms ----
app.get('/sites/:siteId/forms', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/forms`);
  res.json({ status: 'ok', forms: data });
}));

app.get('/forms/:formId/schema', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/forms/${req.params.formId}/schema`);
  res.json({ status: 'ok', schema: data });
}));

app.get('/form-submissions', asyncHandler(async (req, res) => {
  const data = await wf('GET', '/form-submissions', { query: req.query });
  res.json({ status: 'ok', submissions: data });
}));

app.get('/form-submissions/:submissionId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/form-submissions/${req.params.submissionId}`);
  res.json({ status: 'ok', submission: data });
}));

app.get('/sites/:siteId/form-submissions', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/form-submissions`, { query: req.query });
  res.json({ status: 'ok', submissions: data });
}));

app.patch('/form-submissions/:submissionId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/form-submissions/${req.params.submissionId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/form-submissions/:submissionId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/form-submissions/${req.params.submissionId}`);
  res.json({ status: 'ok', deleted: data });
}));

// ---- New: Custom Code ----
app.get('/sites/:siteId/registered-scripts', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/registered_scripts`);
  res.json({ status: 'ok', scripts: data });
}));

app.post('/sites/:siteId/registered-scripts/hosted', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/registered_scripts/hosted`, { body: req.body });
  res.status(201).json({ status: 'ok', registered: data });
}));

app.post('/sites/:siteId/registered-scripts/inline', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/registered_scripts/inline`, { body: req.body });
  res.status(201).json({ status: 'ok', registered: data });
}));

app.get('/sites/:siteId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/custom_code`);
  res.json({ status: 'ok', customCode: data });
}));

app.put('/sites/:siteId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('PUT', `/sites/${req.params.siteId}/custom_code`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/sites/:siteId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/sites/${req.params.siteId}/custom_code`);
  res.json({ status: 'ok', deleted: data });
}));

app.get('/pages/:pageId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/pages/${req.params.pageId}/custom_code`);
  res.json({ status: 'ok', customCode: data });
}));

app.put('/pages/:pageId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('PUT', `/pages/${req.params.pageId}/custom_code`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/pages/:pageId/custom-code', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/pages/${req.params.pageId}/custom_code`);
  res.json({ status: 'ok', deleted: data });
}));

// ---- New: Assets ----
app.get('/sites/:siteId/assets', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/assets`, { query: req.query });
  res.json({ status: 'ok', assets: data });
}));

app.get('/assets/:assetId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/assets/${req.params.assetId}`);
  res.json({ status: 'ok', asset: data });
}));

app.post('/sites/:siteId/assets', asyncHandler(async (req, res) => {
  // Assumes multipart form with file; adjust if needed
  const form = new FormData();
  // Example: form.append('file', req.files.file.data, req.files.file.name); (requires express-fileupload middleware)
  // For simplicity, assume body has fields; extend for actual file upload
  Object.entries(req.body).forEach(([k, v]) => form.append(k, v));
  const data = await wfMultipart('POST', `/sites/${req.params.siteId}/assets`, form);
  res.status(201).json({ status: 'ok', created: data });
}));

app.patch('/assets/:assetId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/assets/${req.params.assetId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/assets/:assetId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/assets/${req.params.assetId}`);
  res.json({ status: 'ok', deleted: data });
}));

app.get('/sites/:siteId/asset-folders', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/asset_folders`);
  res.json({ status: 'ok', folders: data });
}));

app.post('/sites/:siteId/asset-folders', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/asset_folders`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.get('/asset-folders/:folderId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/asset_folders/${req.params.folderId}`);
  res.json({ status: 'ok', folder: data });
}));

// ---- New: Users ----
app.get('/sites/:siteId/users', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/users`, { query: req.query });
  res.json({ status: 'ok', users: data });
}));

app.get('/users/:userId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/users/${req.params.userId}`);
  res.json({ status: 'ok', user: data });
}));

app.patch('/users/:userId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/users/${req.params.userId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.delete('/users/:userId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/users/${req.params.userId}`);
  res.json({ status: 'ok', deleted: data });
}));

app.post('/sites/:siteId/users', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/users`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.get('/sites/:siteId/access-groups', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/access_groups`);
  res.json({ status: 'ok', groups: data });
}));

// ---- New: Ecommerce ----
app.get('/sites/:siteId/products', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/products`);
  res.json({ status: 'ok', products: data });
}));

app.post('/sites/:siteId/products', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/products`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.get('/sites/:siteId/products/:productId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/products/${req.params.productId}`);
  res.json({ status: 'ok', product: data });
}));

app.patch('/sites/:siteId/products/:productId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/sites/${req.params.siteId}/products/${req.params.productId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.post('/sites/:siteId/products/:productId/skus', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/products/${req.params.productId}/skus`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.patch('/sites/:siteId/skus/:skuId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/sites/${req.params.siteId}/skus/${req.params.skuId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.get('/sites/:siteId/orders', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/orders`, { query: req.query });
  res.json({ status: 'ok', orders: data });
}));

app.get('/sites/:siteId/orders/:orderId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/orders/${req.params.orderId}`);
  res.json({ status: 'ok', order: data });
}));

app.patch('/sites/:siteId/orders/:orderId', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/sites/${req.params.siteId}/orders/${req.params.orderId}`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.post('/sites/:siteId/orders/:orderId/fulfill', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/orders/${req.params.orderId}/fulfill`, { body: req.body });
  res.json({ status: 'ok', fulfilled: data });
}));

app.post('/sites/:siteId/orders/:orderId/unfulfill', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/orders/${req.params.orderId}/unfulfill`, { body: req.body });
  res.json({ status: 'ok', unfulfilled: data });
}));

app.post('/sites/:siteId/orders/:orderId/refund', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/orders/${req.params.orderId}/refund`, { body: req.body });
  res.json({ status: 'ok', refunded: data });
}));

app.get('/collections/:collectionId/items/:itemId/inventory', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/collections/${req.params.collectionId}/items/${req.params.itemId}/inventory`);
  res.json({ status: 'ok', inventory: data });
}));

app.patch('/collections/:collectionId/items/:itemId/inventory', asyncHandler(async (req, res) => {
  const data = await wf('PATCH', `/collections/${req.params.collectionId}/items/${req.params.itemId}/inventory`, { body: req.body });
  res.json({ status: 'ok', updated: data });
}));

app.get('/sites/:siteId/ecommerce/settings', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/ecommerce/settings`);
  res.json({ status: 'ok', settings: data });
}));

// ---- New: Webhooks ----
app.get('/sites/:siteId/webhooks', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/webhooks`);
  res.json({ status: 'ok', webhooks: data });
}));

app.get('/webhooks/:webhookId', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/webhooks/${req.params.webhookId}`);
  res.json({ status: 'ok', webhook: data });
}));

app.post('/sites/:siteId/webhooks', asyncHandler(async (req, res) => {
  const data = await wf('POST', `/sites/${req.params.siteId}/webhooks`, { body: req.body });
  res.status(201).json({ status: 'ok', created: data });
}));

app.delete('/webhooks/:webhookId', asyncHandler(async (req, res) => {
  const data = await wf('DELETE', `/webhooks/${req.params.webhookId}`);
  res.json({ status: 'ok', deleted: data });
}));

// ---- New: Enterprise/Logs ----
app.get('/workspaces/:workspaceId/audit-logs', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/workspaces/${req.params.workspaceId}/audit_logs`, { query: req.query });
  res.json({ status: 'ok', logs: data });
}));

app.get('/sites/:siteId/activity-logs', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/activity_logs`, { query: req.query });
  res.json({ status: 'ok', logs: data });
}));

app.get('/sites/:siteId/configuration/redirects', asyncHandler(async (req, res) => {
  const data = await wf('GET', `/sites/${req.params.siteId}/configuration/redirects`);
  res.json({ status: 'ok', redirects: data });
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
