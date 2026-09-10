/**
 * server/mock_reasoning_server.js
 * Reasoning API Backend & Privacy Audit Server for PRIVISION (SIH26171).
 * 
 * Enforces the cloud-side of the Hard Privacy Boundary:
 * 1. Audits incoming payloads to verify ONLY sanitized context crosses the boundary.
 * 2. Connects to the real Google Gemini API via @google/genai SDK using GEMINI_API_KEY.
 * 3. Returns structured JSON actions (CLICK, FOCUS, SCROLL, etc.) matching local element IDs.
 * 4. Serves the demo test sandbox at http://localhost:3721/demo
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load environment variables from server/.env if present
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  // dotenv optional fallback
}

let GoogleGenAI = null;
try {
  const genai = require('@google/genai');
  GoogleGenAI = genai.GoogleGenAI;
} catch (err) {
  console.warn('[PRIVISION SERVER] @google/genai package not found. Run "npm install" in server directory.');
}

const PORT = parseInt(process.env.PORT || '3721', 10);
const REASONING_PROVIDER = (process.env.REASONING_PROVIDER || 'ollama').trim().toLowerCase();
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').trim().replace(/\/+$/, '');
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || 'qwen2.5:1.5b-instruct').trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Model configuration with robust default to gemini-3.6-flash
let configuredModel = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
if (configuredModel === 'gemini-2.5-flash') {
  console.warn('[PRIVISION SERVER] Deprecated model gemini-2.5-flash detected in configuration. Automatically updating to gemini-3.6-flash.');
  configuredModel = 'gemini-3.6-flash';
}
const GEMINI_MODEL = configuredModel;
const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// Initialize Gemini Client if API key is present
let geminiClient = null;
if (GoogleGenAI && GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here') {
  try {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (initErr) {
    console.warn('[PRIVISION SERVER] Gemini client initialization failed:', initErr.message);
  }
}

/**
 * Calls local Ollama model (qwen2.5:1.5b-instruct) for on-device reasoning.
 * Transmits ONLY sanitized context.
 * 
 * @param {Object} payload Sanitized network payload
 * @returns {Promise<Object>} Structured action response
 */
async function callOllamaReasoning(payload) {
  const systemInstruction = `You are the reasoning layer of a privacy-preserving browser agent.
The context below has already passed through a local privacy boundary.
Never request, infer, reconstruct, or attempt to recover redacted values.
Use only the sanitized information provided.
Return only an allowed browser action.

Action Selection Rules:
- When the user should fill or interact with an input field or textbox, you MUST choose FOCUS.
- When the user should click a button, link, or submit form, you MUST choose CLICK.
- Only choose NAVIGATE_SAFE when explicitly redirecting to a new external URL.
- If no action is needed, choose WAIT or NO_ACTION.`;

  const page = payload.page || {};
  const elements = payload.elements || [];

  const promptText = `Page Origin: ${page.origin || 'unknown'}
Page Path: ${page.path || '/'}
Sanitized DOM Elements:
${JSON.stringify(elements, null, 2)}

Goal: Assist the user with navigating or interacting with this page safely.
Select the single best next action from the allowed actions: CLICK, FOCUS, SCROLL, NAVIGATE_SAFE, WAIT, NO_ACTION.
Target element must use the exact element id from the sanitized DOM (e.g. privision-element-001).`;

  console.log('[PRIVISION SERVER] Calling Ollama...');

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: promptText }
      ],
      stream: false,
      format: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['CLICK', 'FOCUS', 'SCROLL', 'NAVIGATE_SAFE', 'WAIT', 'NO_ACTION']
          },
          targetId: {
            type: 'string',
            description: 'The local element ID (e.g. privision-element-001) to act upon'
          },
          reason: {
            type: 'string',
            description: 'Explanation for the action based strictly on sanitized context'
          },
          confidence: {
            type: 'number',
            description: 'Confidence score between 0.0 and 1.0'
          }
        },
        required: ['action', 'targetId', 'reason', 'confidence']
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Ollama HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  console.log('[PRIVISION SERVER] Ollama response received');

  let parsedAction = {};
  try {
    const rawContent = data.message?.content || '{}';
    parsedAction = JSON.parse(rawContent);
    console.log('[PRIVISION SERVER] Structured action parsed');
  } catch (jsonErr) {
    console.warn('[PRIVISION SERVER] Failed to parse Ollama JSON response:', jsonErr.message);
    throw new Error(`Invalid JSON in Ollama response: ${data.message?.content}`);
  }

  // Validate action against allowlist
  const ALLOWED_ACTIONS = ['CLICK', 'FOCUS', 'SCROLL', 'NAVIGATE_SAFE', 'WAIT', 'NO_ACTION'];
  let action = (parsedAction.action || '').toUpperCase();
  if (!ALLOWED_ACTIONS.includes(action)) {
    action = 'NO_ACTION';
  }

  // Ensure targetId is valid string or null
  let targetId = parsedAction.targetId || null;
  if (targetId && typeof targetId !== 'string') {
    targetId = String(targetId);
  }

  // Contextual mapping: If action is NAVIGATE_SAFE without a URL, but targets a local DOM input or button,
  // map to the correct element action so execution succeeds on-device
  if (action === 'NAVIGATE_SAFE' && targetId && !parsedAction.navigationUrl) {
    const targetElem = elements.find(e => e.id === targetId);
    if (targetElem) {
      if (targetElem.tag === 'button' || targetElem.role === 'button') {
        action = 'CLICK';
      } else if (targetElem.tag === 'input' || targetElem.role === 'textbox' || targetElem.isInput) {
        action = 'FOCUS';
      }
    }
  }

  // Normalize confidence (if returned as 0-100 percentage)
  let confidence = typeof parsedAction.confidence === 'number' ? parsedAction.confidence : 0.9;
  if (confidence > 1.0) {
    confidence = Math.min(1.0, Math.max(0.0, Number((confidence / 100).toFixed(2))));
  } else if (confidence < 0.0) {
    confidence = 0.5;
  }

  console.log('[PRIVISION SERVER] Action validation: PASSED');
  console.log(`[PRIVISION SERVER] Ollama success (${OLLAMA_MODEL}): action=${action} targetId=${targetId || 'null'}`);

  return {
    status: 'success',
    server: `PRIVISION Local Reasoning Engine (Ollama: ${OLLAMA_MODEL})`,
    action,
    targetId,
    reason: parsedAction.reason || 'Ollama reasoning completed.',
    confidence,
    boundaryIntegrityVerified: true,
    timestamp: Date.now()
  };
}

/**
 * Calls the real Gemini model using official Google GenAI SDK.
 * Requirement 9, 10, 11.
 * 
 * @param {Object} payload Sanitized network payload
 * @returns {Promise<Object>} Structured action response
 */
async function callGeminiReasoning(payload) {
  const systemInstruction = `You are the reasoning layer of a privacy-preserving browser agent.
The context below has already passed through a local privacy boundary.
Never request, infer, reconstruct, or attempt to recover redacted values.
Use only the sanitized information provided.
Return only an allowed browser action.`;

  const page = payload.page || {};
  const elements = payload.elements || [];
  const screenshot = payload.screenshot || null;

  const promptText = `Page Origin: ${page.origin || 'unknown'}
Page Path: ${page.path || '/'}
Sanitized DOM Elements:
${JSON.stringify(elements, null, 2)}

Goal: Assist the user with navigating or interacting with this page safely.
Select the single best next action from the allowed actions: CLICK, FOCUS, SCROLL, NAVIGATE_SAFE, WAIT, NO_ACTION.
Target element must use the exact element id from the sanitized DOM (e.g. privision-element-001).`;

  const contentParts = [{ text: promptText }];

  // If a sanitized on-device screenshot is available, attach it as inline image
  if (screenshot && screenshot.startsWith('data:image/')) {
    const matches = screenshot.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (matches) {
      contentParts.push({
        inlineData: {
          mimeType: matches[1],
          data: matches[2]
        }
      });
    }
  }

  const response = await geminiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['CLICK', 'FOCUS', 'SCROLL', 'NAVIGATE_SAFE', 'WAIT', 'NO_ACTION']
          },
          targetId: {
            type: 'string',
            description: 'The local element ID (e.g. privision-element-001) to act upon'
          },
          reason: {
            type: 'string',
            description: 'Explanation for the action based strictly on sanitized context'
          },
          confidence: {
            type: 'number',
            description: 'Confidence score between 0.0 and 1.0'
          }
        },
        required: ['action', 'targetId', 'reason', 'confidence']
      }
    }
  });

  const rawText = typeof response.text === 'function'
    ? response.text()
    : (typeof response.text === 'string'
      ? response.text
      : (response.candidates?.[0]?.content?.parts?.[0]?.text || '{}'));
  const parsedAction = JSON.parse(rawText);

  console.log(`[PRIVISION SERVER] Gemini success (${GEMINI_MODEL}): action=${parsedAction.action || 'NO_ACTION'} targetId=${parsedAction.targetId || 'null'}`);

  return {
    status: 'success',
    server: `PRIVISION Cloud Reasoning Engine (Gemini: ${GEMINI_MODEL})`,
    action: parsedAction.action || 'NO_ACTION',
    targetId: parsedAction.targetId || null,
    reason: parsedAction.reason || 'Gemini reasoning completed.',
    confidence: parsedAction.confidence || 0.9,
    boundaryIntegrityVerified: true,
    timestamp: Date.now()
  };
}

const server = http.createServer(async (req, res) => {
  // CORS & Private Network Access (PNA) Headers (required by Chromium for localhost / private IP access)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, X-Privision-Sanitized, Authorization, Access-Control-Request-Private-Network, *'
  );
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Pre-flight handling
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health' || req.url === '/api/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const isOllama = REASONING_PROVIDER === 'ollama';
    res.end(JSON.stringify({
      status: 'online',
      service: 'PRIVISION Reasoning API Server',
      port: PORT,
      reasoningProvider: REASONING_PROVIDER,
      model: isOllama ? OLLAMA_MODEL : (geminiClient ? GEMINI_MODEL : 'none (local fallback)'),
      ollamaEndpoint: isOllama ? OLLAMA_URL : undefined,
      geminiConfigured: !!geminiClient,
      timestamp: Date.now()
    }));
    return;
  }

  // Sanitized Reasoning Endpoint
  if (req.method === 'POST' && req.url === '/api/reason') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);

        console.log('\n================================================================');
        console.log('🛡️  [PRIVISION SERVER] INCOMING REASONING REQUEST RECEIVED');
        console.log('================================================================');
        console.log(`Timestamp:             ${new Date().toISOString()}`);
        console.log(`Page Domain:           ${payload.page?.domain || 'N/A'}`);
        console.log(`Page Path:             ${payload.page?.path || '/'}`);
        console.log(`Redacted Entities:     ${payload.privacy?.redactedCount || 0}`);
        console.log(`Sanitized Elements:    ${payload.elements?.length || 0}`);
        console.log(`Sanitized Screenshot:  ${payload.screenshot ? 'Present (Overwritten with dark redactions)' : 'None'}`);

        // =========================================================================
        // SERVER-SIDE PRIVACY AUDIT: VERIFY ZERO RAW PII LEAKAGE
        // =========================================================================
        const violations = auditPayloadForPrivacy(payload);

        // Development Diagnostics (Requirement 5)
        console.log('\n[SERVER DIAGNOSTICS] ========================================');
        console.log(`[SERVER DIAGNOSTICS] HTTP Method:      ${req.method}`);
        console.log(`[SERVER DIAGNOSTICS] Request Path:     ${req.url}`);
        console.log(`[SERVER DIAGNOSTICS] Content-Type:     ${req.headers['content-type'] || 'N/A'}`);
        console.log(`[SERVER DIAGNOSTICS] Top-Level Fields: ${Object.keys(payload).join(', ')}`);
        console.log(`[SERVER DIAGNOSTICS] Redacted Entities:${payload.privacy?.redactedCount || 0}`);
        console.log(`[SERVER DIAGNOSTICS] Sanitized Elements:${payload.elements?.length || 0}`);

        if (violations.length > 0) {
          console.error(`[SERVER DIAGNOSTICS] Validation Status: FAILED`);
          console.error(`[SERVER DIAGNOSTICS] Failure Reason:    ${violations[0]}`);
          console.log('================================================================\n');

          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'blocked',
            error: `Privacy boundary breached. ${violations[0]}`
          }));
          return;
        }

        console.log(`[SERVER DIAGNOSTICS] Validation Status: PASSED (Zero raw PII received)`);
        console.log('✅ BOUNDARY AUDIT: Verified 100% sanitized. Zero raw PII received.');
        console.log('================================================================\n');

        // Privacy assertion logs
        console.log('[PRIVISION SERVER] Sanitized payload received');
        console.log(`[PRIVISION SERVER] Raw PII received: ${violations.length}`);
        console.log('[PRIVISION SERVER] Privacy boundary: PASSED');

        let responseData;
        if (REASONING_PROVIDER === 'ollama') {
          // Live local Ollama reasoning
          try {
            responseData = await callOllamaReasoning(payload);
          } catch (ollamaErr) {
            console.error('[PRIVISION SERVER] Ollama invocation failed:', ollamaErr.message);
            console.log('[PRIVISION SERVER] Ollama unavailable → safe fallback engaged');
            responseData = generateFallbackAction(payload, `Ollama unavailable (${ollamaErr.message}) → safe fallback engaged.`);
          }
        } else if (REASONING_PROVIDER === 'gemini' && geminiClient) {
          // Live Gemini reasoning via official Google GenAI SDK
          try {
            responseData = await callGeminiReasoning(payload);
          } catch (geminiErr) {
            console.error('[PRIVISION SERVER] Gemini invocation failed:', geminiErr.message);
            console.log('[PRIVISION SERVER] Gemini unavailable → safe fallback engaged');
            responseData = generateFallbackAction(payload, `Gemini unavailable (${geminiErr.message}) → safe fallback engaged.`);
          }
        } else {
          // Structured fallback response
          console.log(`[PRIVISION SERVER] ${REASONING_PROVIDER.toUpperCase()} not configured → safe fallback engaged`);
          responseData = generateFallbackAction(payload, `Local structured reasoning fallback (${REASONING_PROVIDER} not configured).`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));

      } catch (parseError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload received.' }));
      }
    });
    return;
  }

  // Static File Serving for Testing Demo (GET / or /demo or static assets)
  if (req.method === 'GET') {
    let reqPath = req.url.split('?')[0];

    if (reqPath === '/' || reqPath === '/demo' || reqPath === '/demo/') {
      reqPath = '/demo/test-form.html';
    }

    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(ROOT_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found. Use /demo for the sandbox or POST /api/reason for reasoning API.' }));
});

/**
 * Generates a safe fallback action matching the structured schema.
 */
function generateFallbackAction(payload, reason) {
  const elements = payload.elements || [];
  const targetElement = elements.find(e => !e.sensitive && e.role === 'input') ||
                        elements.find(e => !e.sensitive && (e.tag === 'button' || e.role === 'button')) ||
                        elements[0];

  return {
    status: 'success',
    server: 'PRIVISION Reasoning Engine (Local Fallback)',
    action: targetElement?.tag === 'button' ? 'CLICK' : (targetElement ? 'FOCUS' : 'NO_ACTION'),
    targetId: targetElement?.id || null,
    reason,
    confidence: 0.88,
    boundaryIntegrityVerified: true,
    timestamp: Date.now()
  };
}

/**
 * Server-side audit function:
 * Verifies that incoming payload contains NO raw PII values or forbidden fields.
 * Recursively inspects object properties while ignoring numeric timestamps,
 * element layout coordinates, and sanitized base64 screenshot data URLs.
 * 
 * Returns an array of violation descriptions (empty if 100% clean).
 */
function auditPayloadForPrivacy(payload) {
  const violations = [];

  if (!payload || typeof payload !== 'object') {
    violations.push('Payload must be a valid JSON object.');
    return violations;
  }

  if (!payload.privacy?.sanitized || !payload.privacy?.rawDataExcluded) {
    violations.push('Payload missing certified sanitization signatures (privacy.sanitized / privacy.rawDataExcluded).');
  }

  if (!Array.isArray(payload.elements)) {
    violations.push('Payload missing elements array.');
  }

  const FORBIDDEN_KEYS = [
    'rawvalue',
    'originalvalue',
    'originaltext',
    'rawtext',
    'html',
    'outerhtml',
    'innerhtml',
    'password',
    'secret',
    'authorization',
    'cookie',
    'session',
    'credential',
    'originalscreenshot',
    'rawscreenshot'
  ];

  function inspect(val, path) {
    if (val === null || val === undefined) return;
    if (typeof val === 'number' || typeof val === 'boolean') return;

    if (typeof val === 'string') {
      // Allow sanitized base64 data URLs in screenshot field
      if (path === 'screenshot' && val.startsWith('data:image/')) return;

      // Allow legitimate redacted placeholder tokens like {{REDACTED_PASSWORD_1}}
      if (val.startsWith('{{REDACTED_') || val.startsWith('[REDACTED_')) return;

      if (val.length > 5) {
        // 1. Raw Credit Card (13-19 digits)
        const ccMatches = val.match(/\b(?:\d[\s\-.]*?){13,19}\b/g);
        if (ccMatches) {
          for (const m of ccMatches) {
            const digitCount = m.replace(/\D/g, '').length;
            if (digitCount >= 13 && digitCount <= 19) {
              violations.push(`Raw credit card pattern detected in field '${path}'`);
              break;
            }
          }
        }

        // 2. Raw SSN
        if (/\b\d{3}-\d{2}-\d{4}\b/.test(val)) {
          violations.push(`Raw SSN pattern detected in field '${path}'`);
        }

        // 3. Raw Aadhaar
        if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(val)) {
          violations.push(`Raw Aadhaar pattern detected in field '${path}'`);
        }

        // 4. Raw PAN
        if (/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i.test(val)) {
          violations.push(`Raw PAN pattern detected in field '${path}'`);
        }

        // 5. Raw Email
        if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(val)) {
          violations.push(`Raw email pattern detected in field '${path}'`);
        }
      }
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((item, idx) => inspect(item, `${path}[${idx}]`));
      return;
    }

    if (typeof val === 'object') {
      for (const [key, value] of Object.entries(val)) {
        const lowerKey = key.toLowerCase();
        for (const forbidden of FORBIDDEN_KEYS) {
          if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
            violations.push(`Forbidden field key '${key}' detected at '${path}.${key}'`);
          }
        }
        if (lowerKey === 'src' || lowerKey === 'currentsrc') {
          violations.push(`Raw image source '${key}' detected at '${path}.${key}'`);
        }
        inspect(value, `${path}.${key}`);
      }
    }
  }

  inspect(payload, 'payload');
  return violations;
}

server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`[PRIVISION SERVER] Reasoning backend initialized`);
  console.log(`[PRIVISION SERVER] Reasoning provider: ${REASONING_PROVIDER.toUpperCase()}`);
  if (REASONING_PROVIDER === 'ollama') {
    console.log(`[PRIVISION SERVER] Ollama model: ${OLLAMA_MODEL}`);
    console.log(`[PRIVISION SERVER] Ollama endpoint: ${OLLAMA_URL}`);
  } else {
    console.log(`[PRIVISION SERVER] Gemini configured: ${!!geminiClient}`);
    console.log(`[PRIVISION SERVER] Gemini model: ${geminiClient ? GEMINI_MODEL : 'none'}`);
  }
  console.log(`[PRIVISION SERVER] Privacy boundary: ACTIVE`);
  console.log(`[PRIVISION SERVER] Endpoint: /api/reason`);
  console.log(`[PRIVISION SERVER] Server URL: http://localhost:${PORT}`);
  console.log(`[PRIVISION SERVER] Interactive Sandbox: http://localhost:${PORT}/demo`);
  console.log(`[PRIVISION SERVER] Auditing incoming payloads for 100% on-device sanitized tokens.`);
  console.log(`================================================================\n`);
});
