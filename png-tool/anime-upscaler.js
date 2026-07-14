// ONNX upscaler models — runs locally via ONNX Runtime Web.
// - anime:   2x-AnimeSharpV4 Fast (RCAN, fp16) — sharpener for clean-ish anime. WebGPU + WASM.
// - restore: realesr-general-x4v3 (Real-ESRGAN compact, fp32) — restoration model that
//            deblurs and removes JPEG artifacts; best for low-quality sources. WASM only:
//            ORT's WebGPU backend fails on this model's final Clip node (verified 1.19→1.27),
//            same class of bug that breaks all ESRGAN/RRDB models ending in a 3-channel conv.
// Everything (runtime + models) is lazy-loaded on first use.
(function () {
    const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.js';
    const WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
    const TILE = 128; // input-space tile size
    const PAD = 12;   // tile overlap (hides seams)

    const MODELS = {
        anime: {
            url: 'https://huggingface.co/Kim2091/2x-AnimeSharpV4/resolve/main/2x-AnimeSharpV4_Fast_RCAN_PU_fp16_opset17.onnx',
            scale: 2, dtype: 'float16', label: 'AnimeSharp', gpuOk: true
        },
        restore: {
            url: 'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx',
            scale: 4, dtype: 'float32', label: 'Real-ESRGAN Restore', gpuOk: false
        }
    };

    // float16 helpers
    const hasF16 = typeof Float16Array !== 'undefined';
    const _f32 = new Float32Array(1);
    const _u32 = new Uint32Array(_f32.buffer);
    function f32ToF16(val) {
        _f32[0] = val;
        const x = _u32[0];
        const sign = (x >> 16) & 0x8000;
        const exp = ((x >> 23) & 0xff) - 112;
        if (exp <= 0) return sign;
        if (exp >= 31) return sign | 0x7bff;
        return sign | (exp << 10) | ((x >> 13) & 0x3ff);
    }
    function f16ToF32(bits) {
        const sign = (bits & 0x8000) ? -1 : 1;
        const exp = (bits >> 10) & 0x1f;
        const mant = bits & 0x3ff;
        if (exp === 0) return sign * mant * Math.pow(2, -24);
        if (exp === 31) return mant ? NaN : sign * Infinity;
        return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
    }
    function makeInputArray(dtype, n) {
        if (dtype === 'float32') return new Float32Array(n);
        return hasF16 ? new Float16Array(n) : new Uint16Array(n);
    }
    function inputSet(dtype, arr, i, v) { arr[i] = (dtype === 'float16' && !hasF16) ? f32ToF16(v) : v; }
    function outputGet(data, i) { return (data instanceof Uint16Array) ? f16ToF32(data[i]) : data[i]; }

    let ortLoadPromise = null;
    const sessions = {};        // modelKey -> Promise<session>
    const sessionIsGPU = {};    // modelKey -> bool
    let gpuFailReason = '';

    function loadOrt() {
        if (window.ort) return Promise.resolve();
        if (!ortLoadPromise) {
            ortLoadPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = ORT_URL;
                s.onload = () => resolve();
                s.onerror = () => reject(new Error('Failed to load ONNX Runtime from CDN'));
                document.head.appendChild(s);
            });
        }
        return ortLoadPromise;
    }

    async function fetchModel(cfg, onStatus) {
        const res = await fetch(cfg.url);
        if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status})`);
        const total = parseInt(res.headers.get('content-length') || '0', 10);
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (onStatus && total) {
                onStatus(`Downloading ${cfg.label} model... ${Math.round(received / total * 100)}% of ${Math.round(total / 1e6)} MB (first time only)`);
            }
        }
        const buf = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        return buf;
    }

    async function getSession(modelKey, onStatus) {
        await loadOrt();
        if (!sessions[modelKey]) {
            sessions[modelKey] = (async () => {
                const cfg = MODELS[modelKey];
                ort.env.wasm.wasmPaths = WASM_DIR;
                ort.env.logLevel = 'error';
                const modelData = await fetchModel(cfg, onStatus);
                if (onStatus) onStatus(`Initializing ${cfg.label} model...`);
                // Warmup inference validates the backend actually RUNS the model —
                // some WebGPU implementations create the session fine but fail at run().
                async function warmup(s) {
                    const t = new ort.Tensor(cfg.dtype, makeInputArray(cfg.dtype, 3 * 8 * 8), [1, 3, 8, 8]);
                    await s.run({ [s.inputNames[0]]: t });
                    return s;
                }
                if (cfg.gpuOk && navigator.gpu) {
                    try {
                        // pass a COPY (.slice()) — session creation can transfer the buffer,
                        // detaching it and breaking any later attempt.
                        const s = await warmup(await ort.InferenceSession.create(modelData.slice(), { executionProviders: ['webgpu'] }));
                        sessionIsGPU[modelKey] = true;
                        return s;
                    } catch (e) {
                        gpuFailReason = (e && e.message) ? e.message : String(e);
                        console.warn('WebGPU init/run failed, falling back to WASM (CPU):', e);
                    }
                }
                sessionIsGPU[modelKey] = false;
                return warmup(await ort.InferenceSession.create(modelData.slice(), { executionProviders: ['wasm'] }));
            })().catch(err => { sessions[modelKey] = null; throw err; });
        }
        return sessions[modelKey];
    }

    // Upscale an opaque RGB canvas by MODELS[modelKey].scale using tiled inference.
    async function upscaleOnce(modelKey, srcCanvas, opts) {
        const cfg = MODELS[modelKey];
        if (!cfg) throw new Error(`Unknown ONNX model "${modelKey}"`);
        const progress = (opts && opts.progress) || function () {};
        const status = (opts && opts.status) || function () {};
        const session = await getSession(modelKey, status);
        const onGPU = !!sessionIsGPU[modelKey];
        const cpuWhy = cfg.gpuOk
            ? (navigator.gpu ? `CPU — GPU failed: ${gpuFailReason.slice(0, 90)}` : 'CPU — no WebGPU in this browser, slow')
            : 'CPU';
        status(`AI Upscaling (${cfg.label}, ${onGPU ? 'GPU' : cpuWhy})...`);

        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const S = cfg.scale;
        const w = srcCanvas.width, h = srcCanvas.height;
        const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });

        const outCanvas = document.createElement('canvas');
        outCanvas.width = w * S;
        outCanvas.height = h * S;
        const octx = outCanvas.getContext('2d');

        const tilesX = Math.ceil(w / TILE);
        const tilesY = Math.ceil(h / TILE);
        const totalTiles = tilesX * tilesY;
        let doneTiles = 0;
        const t0 = performance.now();

        for (let ty = 0; ty < tilesY; ty++) {
            for (let tx = 0; tx < tilesX; tx++) {
                const cx = tx * TILE, cy = ty * TILE;
                const cw = Math.min(TILE, w - cx), ch = Math.min(TILE, h - cy);
                const rx = Math.max(0, cx - PAD), ry = Math.max(0, cy - PAD);
                const rw = Math.min(w, cx + cw + PAD) - rx;
                const rh = Math.min(h, cy + ch + PAD) - ry;

                const imgData = sctx.getImageData(rx, ry, rw, rh);
                const px = imgData.data;
                const input = makeInputArray(cfg.dtype, 3 * rw * rh);
                const plane = rw * rh;
                for (let i = 0; i < plane; i++) {
                    inputSet(cfg.dtype, input, i, px[i * 4] / 255);
                    inputSet(cfg.dtype, input, plane + i, px[i * 4 + 1] / 255);
                    inputSet(cfg.dtype, input, 2 * plane + i, px[i * 4 + 2] / 255);
                }

                const tensor = new ort.Tensor(cfg.dtype, input, [1, 3, rh, rw]);
                const results = await session.run({ [inputName]: tensor });
                const out = results[outputName];
                const [, , oh, ow] = out.dims;
                const data = out.data;
                const oplane = ow * oh;

                const coreX = (cx - rx) * S, coreY = (cy - ry) * S;
                const coreW = cw * S, coreH = ch * S;
                const outImg = octx.createImageData(coreW, coreH);
                const od = outImg.data;
                for (let y = 0; y < coreH; y++) {
                    const srcRow = (coreY + y) * ow;
                    for (let x = 0; x < coreW; x++) {
                        const si = srcRow + coreX + x;
                        const di = (y * coreW + x) * 4;
                        od[di] = Math.max(0, Math.min(255, outputGet(data, si) * 255));
                        od[di + 1] = Math.max(0, Math.min(255, outputGet(data, oplane + si) * 255));
                        od[di + 2] = Math.max(0, Math.min(255, outputGet(data, 2 * oplane + si) * 255));
                        od[di + 3] = 255;
                    }
                }
                octx.putImageData(outImg, cx * S, cy * S);

                doneTiles++;
                progress(doneTiles / totalTiles);
                const perTile = (performance.now() - t0) / doneTiles;
                const etaS = Math.round(perTile * (totalTiles - doneTiles) / 1000);
                status(`AI Upscaling (${cfg.label}, ${onGPU ? 'GPU' : 'CPU'})... tile ${doneTiles}/${totalTiles}${etaS > 0 ? `, ~${etaS >= 60 ? Math.ceil(etaS / 60) + ' min' : etaS + 's'} left` : ''}`);
                // Yield to the UI thread between tiles
                await new Promise(r => setTimeout(r, 0));
            }
        }
        return outCanvas;
    }

    window.OnnxUpscaler = { upscaleOnce, models: MODELS };
})();
