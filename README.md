# PRIVISION — On-Device Visual Perception Layer for Lightweight Browser Agents

> **Smart India Hackathon 2024 / 2026** — Problem Statement **SIH26171**  
> **Submitted by:** Team Theia  
> **Platform:** Chromium Extension (Manifest V3, Pure ES Modules) — Compatible with Chrome, Edge, Brave, Opera, Arc

---

## 1. Project Summary & The Hard Privacy Boundary

**PRIVISION** is a privacy-preserving visual-perception and redaction shield that sits between the user's active browser tab and downstream AI reasoning agents. Autonomous browser agents typically require continuous visual or DOM context to understand page state. However, sending raw browser screens or DOM trees to cloud models risks exposing passwords, credit cards, national IDs, and personal biometric avatars.

### Core Security Rule: Visual Redaction != Network Privacy
Hiding sensitive text on the screen is not sufficient for privacy. If the network transmission payload contains raw values or unredacted screenshots, the cloud AI still sees the sensitive data. 

PRIVISION treats local sanitization as a **HARD PRIVACY BOUNDARY**:
1. **Local Capture (Local Only):** Reads visible DOM layout and tab screenshot locally to detect sensitive areas.
2. **Local Perception & Detection (Local Only):** Combines DOM attributes (types, autocomplete, ARIA) and visual heuristics to flag sensitive fields under a strict **fail-closed policy**.
3. **On-Device Redaction & Masking:**
   - **User Screen:** Renders an Apple Photos *Clean Up* / Google Photos *Magic Eraser* scan &rarr; progressive blur &rarr; settled dark bar animation.
   - **Network Screenshot:** An in-memory `<canvas>` permanently over-paints every sensitive bounding box with solid opaque dark rectangles and replacement token tags (`{{REDACTED_...}}`).
   - **DOM Elements:** Raw values, names, IDs, placeholders, and raw image `src` URLs are stripped; each element is assigned an anonymous stable ID (`privision-element-001`, `privision-element-002`).
4. **Second Privacy Gate (`assertSafeForNetwork`):** Recursively inspects the outgoing payload. If any forbidden key (`rawValue`, `html`, `password`, `cookie`, etc.) or unmasked PII pattern is detected, it **fails closed** and blocks network transmission (`NETWORK SHARING: BLOCKED`).
5. **Real Gemini Cloud Reasoning Backend:** Sends only the sanitized payload to a lightweight Node.js backend using the official Google GenAI SDK (`@google/genai`). The extension contains **zero API keys**; `GEMINI_API_KEY` is kept exclusively on the backend server.
6. **Structured Action Validation:** Gemini responds strictly with structured JSON actions (`CLICK`, `FOCUS`, `SCROLL`, `NAVIGATE_SAFE`, `WAIT`, `NO_ACTION`) referencing safe element IDs (`privision-element-xxx`). The extension locally validates and safely executes the action without evaluating arbitrary code.

---

## 2. Pipeline Architecture

```
PAGE
  │
  ▼
LOCAL CAPTURE (DOM geometry + raw tab screenshot — on-device only)
  │
  ▼
LOCAL PERCEPTION & PII DETECTION (DOM taxonomy + visual heuristics — fail-closed)
  │
  ▼
LOCAL SANITIZATION (In-memory canvas screenshot redaction + anonymous element IDs)
  │
  ▼
PRIVACY BOUNDARY (assertSafeForNetwork recursive audit — fail-closed gate)
  │
  ▼
SANITIZED CONTEXT (Tokens only + sanitized screenshot + safe metadata)
  │
  ▼
REASONING BACKEND / GEMINI (@google/genai with strict zero-reconstruction prompt)
  │
  ▼
STRUCTURED ACTION JSON ({ action: "CLICK", targetId: "privision-element-002" })
  │
  ▼
LOCAL ACTION VALIDATION (Enforce action enum & resolve element locally — no eval)
  │
  ▼
SAFE BROWSER ACTION
```

---

## 3. Repository Structure

```
privision/
├── manifest.json                  # Manifest V3 specification & CSP
├── background.js                  # Service Worker (badge state, domain allowlist, screenshot bridge)
├── content-scripts/
│   └── content.js                 # In-page coordinator driving the 6-stage pipeline
├── lib/
│   └── pipeline/
│       ├── capture.js             # Stage 1: LocalCapture & URL sanitization (strips query parameters)
│       ├── perceive.js            # Stage 2: DOM taxonomy & prototype visual perception heuristics
│       ├── detect.js              # Stage 3: Multi-modal fail-closed sensitivity detection
│       ├── redact.js              # Stage 4: On-screen animation & canvas sanitized screenshot generator
│       ├── reason.js              # Stage 5: Second privacy gate (assertSafeForNetwork) & network dispatch
│       └── act.js                 # Stage 6: Structured action validation & Agent Action HUD
├── models/
│   ├── model-card.json            # Model specifications (MobileViT INT8 targets, prototype placeholder status)
│   └── README.md                  # Honest documentation on prototype model state & BYOM architecture
├── popup/
│   ├── popup.html                 # Extension toolbar popup
│   ├── popup.js                   # State synchronization & "LOCAL PRIVACY BOUNDARY: ACTIVE" status
│   └── popup.css                  # Minimal, high-contrast dark blue UI
├── options/
│   ├── options.html               # BYOM portal, sensitivity slider, domain allowlist, live playground
│   ├── options.js                 # Settings persistence & model sanity testing
│   └── options.css                # Full options page styling
├── styles/
│   └── redact.css                 # Apple Photos Clean Up / Magic Eraser CSS animations & HUD
├── demo/
│   └── test-form.html             # High-security test bench with traceable fake PII & live leak audit
├── server/
│   ├── package.json               # Backend dependencies: @google/genai, dotenv
│   ├── .env.example               # Template for GEMINI_API_KEY & GEMINI_MODEL
│   └── mock_reasoning_server.js   # Real Gemini backend, payload audit & demo static server
├── tests/
│   └── privacy_boundary_test.js   # Automated leak test suite searching for raw fake PII
└── scripts/
    └── generate_icons.js          # Generator for extension PNG icons (16x16, 48x48, 128x128)
```

---

## 4. Quick Start: Install, Run & Test

### Step 1: Install Backend Dependencies
Open PowerShell in the `server` directory and run:
```powershell
cd "c:\Users\Ashraf\Desktop\sih_project - Copy\server"
npm install
```

### Step 2: Configure Gemini API Key (Optional for Live AI)
In the `server` directory, create a `.env` file (copy from `.env.example`):
```powershell
cp .env.example .env
```
Open `server/.env` and set your credentials:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
PORT=3721
```
*(Note: If `GEMINI_API_KEY` is omitted, the server operates in local structured reasoning fallback mode, still verifying the privacy boundary!)*

### Step 3: Start the Backend Server
From the project root or server directory, run:
```powershell
node server/mock_reasoning_server.js
```
You should see:
```
================================================================
[PRIVISION SERVER] Reasoning backend initialized
[PRIVISION SERVER] Gemini configured: true
[PRIVISION SERVER] Gemini model: gemini-3.6-flash
[PRIVISION SERVER] Privacy boundary: ACTIVE
[PRIVISION SERVER] Endpoint: /api/reason
================================================================
```

### Step 4: Load the Chrome Extension Unpacked
1. Open Google Chrome, Microsoft Edge, Brave, Opera, or Arc.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **"Load unpacked"** and select:
   `c:\Users\Ashraf\Desktop\sih_project - Copy`
5. Confirm the extension is active with the blue shield logo.

---

## 5. How to Test the Privacy Boundary

### Method A: Automated Test Suite (Terminal)
Run the automated leak verification suite from the project root:
```powershell
node tests/privacy_boundary_test.js
```
Output:
```
================================================================
🧪 RUNNING PRIVISION HARD PRIVACY BOUNDARY LEAK TEST SUITE
================================================================
  ✅ [PASS] URL Sanitizer strips sensitive query parameters and hash fragments
  ✅ [PASS] SensitivityDetector identifies passwords, cards, PAN, Aadhaar, email, phone
  ✅ [PASS] NetworkPayload contains ZERO instances of original fake PII values
  ✅ [PASS] assertSafeForNetwork() rejects forbidden fields and triggers FAIL CLOSED
----------------------------------------------------------------
RESULTS: 4 / 4 tests passed.
HARD PRIVACY BOUNDARY INTEGRITY: FULLY VERIFIED.
----------------------------------------------------------------
```

### Method B: Live In-Browser Leak Audit & Visual Demo
1. Open your browser and navigate to:
   `http://localhost:3721/demo?session_token=SECRET_TOKEN_999&user_email=ananya@example.com`
2. Notice the simulated sensitive URL parameters and the test form populated with traceable fake PII:
   - **Name:** `Ananya Sen`
   - **Email:** `ananya@example.com`
   - **Phone:** `9876543210`
   - **PAN Card:** `ABCDE1234F`
   - **Aadhaar ID:** `1234 5678 9012`
   - **Credit Card:** `4111 1111 1111 1111`
   - **Password:** `MySecretPassword123`
3. Click **"Run Privacy Boundary Leak Test"** on the page.
4. The page will run an audit scanning the sanitized layer for all 8 target fake values and display a verified checklist confirming 0 leaks.
5. Open Chrome DevTools (`F12`) &rarr; **Console** to see the privacy audit table:
   ```
   ┌─────────────────────────────┬────────┐
   │ (index)                     │ Values │
   ├─────────────────────────────┼────────┤
   │ rawPIIDetected              │ false  │
   │ rawScreenshotIncluded       │ false  │
   │ sanitizedScreenshotIncluded │ true   │
   │ sanitizedDomIncluded        │ true   │
   │ privacyBoundaryPassed       │ true   │
   └─────────────────────────────┴────────┘
   ```
6. Open Chrome DevTools &rarr; **Network** tab &rarr; inspect `POST http://localhost:3721/api/reason`:
   - Verify: `ananya@example.com`, `MySecretPassword123`, `4111 1111 1111 1111`, and `SECRET_TOKEN_999` are **nowhere** in the request body.
   - Verify: `screenshot` contains opaque black bars over the input regions.
   - Verify: Agent HUD on bottom-right displays `LOCAL PRIVACY BOUNDARY: ACTIVE` and the validated action.

---

## 6. Sample Sanitized Network Payload

Here is an exact excerpt of what crosses the privacy boundary to the reasoning server:

```json
{
  "protocolVersion": "privision-v2.0",
  "timestamp": 1788970137111,
  "page": {
    "domain": "localhost",
    "origin": "http://localhost:3721",
    "path": "/demo"
  },
  "viewport": { "width": 1280, "height": 800 },
  "elements": [
    {
      "id": "privision-element-001",
      "tag": "input",
      "type": "email",
      "role": "textbox",
      "sensitive": true,
      "value": "{{REDACTED_EMAIL_1}}",
      "bounds": { "x": 100, "y": 200, "width": 250, "height": 35 }
    },
    {
      "id": "privision-element-002",
      "tag": "input",
      "type": "password",
      "role": "password",
      "sensitive": true,
      "value": "{{REDACTED_PASSWORD_2}}",
      "bounds": { "x": 100, "y": 260, "width": 250, "height": 35 }
    },
    {
      "id": "privision-element-003",
      "tag": "button",
      "role": "button",
      "sensitive": false,
      "text": "Continue Safely",
      "bounds": { "x": 100, "y": 320, "width": 120, "height": 36 }
    }
  ],
  "screenshot": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/...",
  "privacy": {
    "sanitized": true,
    "rawDataExcluded": true,
    "redactedCount": 2,
    "localPrivacyBoundaryActive": true
  }
}
```

---

## 7. Sample Gemini Response

Here is an exact structured response returned by Gemini:

```json
{
  "status": "success",
  "server": "PRIVISION Cloud Reasoning Engine (Gemini: gemini-3.6-flash)",
  "action": "CLICK",
  "targetId": "privision-element-003",
  "reason": "The page credentials have been redacted on-device. Proceeding to click the safe submission button.",
  "confidence": 0.95,
  "boundaryIntegrityVerified": true,
  "timestamp": 1788970137520
}
```

---

## 8. Why the Cloud Cannot See the Original Email

1. **Explicit Data Separation:** `PageCapture` creates an internal `LocalCapture` object holding the raw DOM node references. This object is strictly local and never serialized for transmission.
2. **Structural Sanitized Representation:** `ContextRedactor` builds a completely new, clean object array (`SanitizedContext.elements`). For sensitive nodes, only `{ id: "privision-element-xxx", sensitive: true, value: "{{REDACTED_EMAIL_1}}", bounds }` is placed in this array. No `rawValue`, `originalText`, `placeholder`, `name`, or HTML attributes are ever copied.
3. **Canvas Redaction Overwrite:** The tab screenshot is loaded onto a local `<canvas>`. Opaque solid `#0F172A` rectangles are drawn over the exact pixel coordinates of the email field, permanently replacing the original pixels with a dark bar and token label before the canvas is exported to base64.
4. **URL Query Parameter Stripping:** `window.location.href` is parsed and stripped of all query strings and fragments.
5. **Recursive Gatekeeper (`assertSafeForNetwork`):** Before `fetch()` is executed, the entire payload is inspected recursively. If any forbidden field name or unmasked email pattern exists, an exception is thrown, the request is permanently aborted, and the extension enters `NETWORK SHARING: BLOCKED`.
6. **No Client-Side Keys:** The Chrome extension has no Gemini API key. It can only communicate with the local backend endpoint (`/api/reason`), which audits payloads before calling Gemini.

---

## 9. Prototype Limitations

In accordance with responsible AI feasibility guidelines for hackathon submissions:

1. **Hackathon Prototype Scope:** This project demonstrates the feasibility of an on-device perception layer and privacy boundary. It does not claim production-grade, certified privacy across arbitrary third-party web frameworks.
2. **Current Model State (Requirement 17):** In this prototype commit, no physical `.onnx` model file is bundled in the repository. Visual perception is implemented as a prototype placeholder using spatial bounding geometry and DOM taxonomy heuristics.
3. **Benchmarking Required:** Redaction recall on non-standard, obfuscated, or canvas-rendered inputs requires dedicated benchmark testing against diverse datasets before real-world trust claims can be made.
4. **Hardware Requirements:** While WASM CPU fallback guarantees functionality on any device, WebGPU acceleration requires a Chromium browser version 113+ with GPU drivers enabled.
