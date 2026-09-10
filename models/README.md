# PRIVISION On-Device Vision Models & BYOM Architecture

This directory documents the on-device visual perception layer, model specifications, and Bring Your Own Model (BYOM) portal for **PRIVISION** (Smart India Hackathon problem statement **SIH26171**).

---

## 1. Prototype Model State & Implementation Status

> [!NOTE]
> **Current Model State (Requirement 17):**  
> In this prototype implementation, no physical `.onnx` weights binary is bundled directly in the extension repository. Visual perception is implemented as a **PROTOTYPE PLACEHOLDER** utilizing spatial bounding geometry, aspect-ratio heuristics, and DOM taxonomy extraction. We do not pretend an active ONNX weight execution is occurring until weights are bundled or supplied via the BYOM portal. The primary engineering focus of this prototype is the **hard local-to-cloud privacy boundary** and the **real Google Gemini reasoning integration**.

---

## 2. Target MobileViT Architecture Specifications

The pipeline is architected around a compact, quantized **MobileViT** (Visual Transformer with MobileNet convolutions) for real-time client inference:

- **Target Architecture:** MobileViT-XXS / MobileViT-Small
- **Target Quantization:** INT8 dynamic post-training quantization
- **Target Size:** ~4.8 MB (INT8 ONNX format)
- **Input Resolution:** `224 × 224 × 3` RGB
- **Peak RAM Target:** `< 20 MB`

### Execution Providers & Acceleration
1. **WebGPU (Primary):**
   - Direct hardware acceleration via `navigator.gpu` in Chromium browsers (Chrome, Edge, Brave, Opera, Arc).
   - Offloads matrix multiplication to client GPU.
   - Benchmark target: **8 ms – 15 ms** per pass.
2. **WASM / CPU (Automatic Fallback):**
   - Automatically engaged when WebGPU is unavailable or unsupported.
   - Benchmark target: **28 ms – 45 ms** per pass.

---

## 3. Bring Your Own Model (BYOM) Portal

Users and administrators can configure custom perception models via the PRIVISION Options page (`chrome-extension://<id>/options/options.html`):

### Option A: Default MobileViT (Bundled Interface)
Uses the internal on-device perception interface. Operates 100% locally with zero cloud transmission.

### Option B: Hugging Face Model ID via Transformers.js
Load compatible vision models directly from Hugging Face Hub (e.g. `Xenova/mobilevit-small`).

### Option C: Custom ONNX Weights URL
Supply an HTTPS link pointing to custom quantized `.onnx` weights hosted on an internal CDN or artifact repository.

### Option D: Private / Enterprise Inference Endpoint
Point PRIVISION to an on-premises private network inference microservice (e.g. `http://localhost:8080/v1/vision/embed`).

---

## 4. Multi-Modal Fusion: Vision + DOM Cues

Detection merges visual cues and DOM structural signals with a strict **fail-closed policy**:
1. **Visual Cues:** Spatial aspect ratios, bounding box geometry, face avatar framing.
2. **DOM Cues:** Input types (`password`, `email`, `tel`), HTML5 autocomplete attributes (`cc-number`, `current-password`, etc.), ARIA labels, and regular expressions (Credit card, PAN, Aadhaar, SSN).
3. **Fail-Closed Guard:** High-risk credentials are automatically redacted by default even when model confidence is low.
