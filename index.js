// index.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const WEBFLOW_API_BASE_URL = process.env.WEBFLOW_API_BASE_URL || 'https://api.webflow.com/v2';
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;

// Validate required environment variables
if (!WEBFLOW_API_KEY) {
  console.error('ERROR: WEBFLOW_API_KEY is not set in environment variables');
  process.exit(1);
}

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS === '*' ? '*' : process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Optional API token middleware stub (uncomment to enable)
const authenticateToken = (req, res, next) => {
  if (process.env.CONNECTOR_API_TOKEN) {
    const token = req.headers['x-api-token'] || req.query.token;
    if (token !== process.env.CONNECTOR_API_TOKEN) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API token'
      });
    }
  }
  next();
};

// Create axios instance for Webflow API
const webflowAPI = axios.create({
  baseURL: WEBFLOW_API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

// SSE endpoint for MCP protocol
app.get('/sse', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({
    type: 'connection',
    status: 'active',
    message: 'Webflow MCP Connector is active',
    timestamp: new Date().toISOString(),
    capabilities: {
      collections: true,
      items: true,
      crud: true
    }
  })}\n\n`);
  
  // Send heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({
      type: 'heartbeat',
      timestamp: new Date().toISOString()
    })}\n\n`);
  }, 30000);
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    res.end();
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'webflow-mcp-connector',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// List all CMS collections
app.get('/collections', authenticateToken, async (req, res) => {
  try {
    const siteId = req.query.site_id;
    if (!siteId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'site_id query parameter is required'
      });
    }
    
    const response = await webflowAPI.get(`/sites/${siteId}/collections`);
    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching collections:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch collections',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Get specific collection details
app.get('/collections/:collectionId', authenticateToken, async (req, res) => {
  try {
    const { collectionId } = req.params;
    
    const response = await webflowAPI.get(`/collections/${collectionId}`);
    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching collection:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch collection',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// List all items in a collection
app.get('/collections/:collectionId/items', authenticateToken, async (req, res) => {
  try {
    const { collectionId } = req.params;
    const { limit = 100, offset = 0, ...otherParams } = req.query;
    
    const response = await webflowAPI.get(`/collections/${collectionId}/items`, {
      params: {
        limit,
        offset,
        ...otherParams
      }
    });
    
    res.json({
      success: true,
      data: response.data,
      metadata: {
        collection_id: collectionId,
        limit: parseInt(limit),
        offset: parseInt(offset),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching items:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch items',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Get specific item
app.get('/collections/:collectionId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const { collectionId, itemId } = req.params;
    
    const response = await webflowAPI.get(`/collections/${collectionId}/items/${itemId}`);
    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching item:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch item',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Create new item in collection
app.post('/collections/:collectionId/items', authenticateToken, async (req, res) => {
  try {
    const { collectionId } = req.params;
    const { live = false, ...itemData } = req.body;
    
    // Determine endpoint based on live parameter
    const endpoint = live 
      ? `/collections/${collectionId}/items/live`
      : `/collections/${collectionId}/items`;
    
    const response = await webflowAPI.post(endpoint, itemData);
    
    res.status(201).json({
      success: true,
      data: response.data,
      metadata: {
        collection_id: collectionId,
        published: live,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error creating item:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to create item',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Update existing item
app.patch('/collections/:collectionId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const { collectionId, itemId } = req.params;
    const { live = false, ...updateData } = req.body;
    
    // Determine endpoint based on live parameter
    const endpoint = live
      ? `/collections/${collectionId}/items/${itemId}/live`
      : `/collections/${collectionId}/items/${itemId}`;
    
    const response = await webflowAPI.patch(endpoint, updateData);
    
    res.json({
      success: true,
      data: response.data,
      metadata: {
        collection_id: collectionId,
        item_id: itemId,
        published: live,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error updating item:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to update item',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Delete item
app.delete('/collections/:collectionId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const { collectionId, itemId } = req.params;
    const { live = false } = req.query;
    
    // Determine endpoint based on live parameter
    const endpoint = live === 'true'
      ? `/collections/${collectionId}/items/${itemId}/live`
      : `/collections/${collectionId}/items/${itemId}`;
    
    await webflowAPI.delete(endpoint);
    
    res.json({
      success: true,
      message: 'Item deleted successfully',
      metadata: {
        collection_id: collectionId,
        item_id: itemId,
        published: live === 'true',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error deleting item:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to delete item',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Publish items
app.post('/collections/:collectionId/items/publish', authenticateToken, async (req, res) => {
  try {
    const { collectionId } = req.params;
    const { itemIds } = req.body;
    
    if (!itemIds || !Array.isArray(itemIds)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'itemIds array is required in request body'
      });
    }
    
    const response = await webflowAPI.post(`/collections/${collectionId}/items/publish`, {
      itemIds
    });
    
    res.json({
      success: true,
      data: response.data,
      metadata: {
        collection_id: collectionId,
        items_published: itemIds.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error publishing items:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to publish items',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// List sites (useful for getting site IDs)
app.get('/sites', authenticateToken, async (req, res) => {
  try {
    const response = await webflowAPI.get('/sites');
    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching sites:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch sites',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Get specific site details
app.get('/sites/:siteId', authenticateToken, async (req, res) => {
  try {
    const { siteId } = req.params;
    
    const response = await webflowAPI.get(`/sites/${siteId}`);
    res.json({
      success: true,
      data: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching site:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch site',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// Publish site
app.post('/sites/:siteId/publish', authenticateToken, async (req, res) => {
  try {
    const { siteId } = req.params;
    const { domains = [], publishToWebflowSubdomain = true } = req.body;
    
    const response = await webflowAPI.post(`/sites/${siteId}/publish`, {
      domains,
      publishToWebflowSubdomain
    });
    
    res.json({
      success: true,
      data: response.data,
      metadata: {
        site_id: siteId,
        domains_published: domains,
        webflow_subdomain: publishToWebflowSubdomain,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error publishing site:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to publish site',
      message: error.response?.data?.message || error.message,
      details: error.response?.data
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Webflow MCP Connector running on port ${PORT}`);
  console.log(`📡 SSE endpoint available at http://localhost:${PORT}/sse`);
  console.log(`🔑 API Key configured: ${WEBFLOW_API_KEY ? 'Yes' : 'No'}`);
  console.log(`🔒 Authentication: ${process.env.CONNECTOR_API_TOKEN ? 'Enabled' : 'Disabled'}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
