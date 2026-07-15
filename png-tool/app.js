const remover = new PNGOutlineRemover();
const beforeCanvas = document.getElementById('before-canvas');
const beforeCtx = beforeCanvas.getContext('2d');
const afterCanvas = document.getElementById('after-canvas');
const afterCtx = afterCanvas.getContext('2d');

const uploadBtn = document.getElementById('upload-btn');
const processBtn = document.getElementById('process-btn');
const applyBtn = document.getElementById('apply-btn');
const downloadBtn = document.getElementById('download-btn');
const imageInput = document.getElementById('file-input');
const statusBadge = document.getElementById('status-badge');
const uploadBox = document.getElementById('upload-box');
const canvasContainer = document.getElementById('canvas-container');

let baseImageData = null; // The "Base" for the current process
let lastProcessedData = null; // The result of the current process
let lastUnsharpenedData = null; // AI result before the sharpen pass (lets the slider re-apply instantly)

// UI Elements & State
const inputs = {
    strokeWidth: document.getElementById('stroke-width'),
    smoothing: document.getElementById('smoothing'),
    threshold: document.getElementById('threshold'),
    depth: document.getElementById('depth'),
    matchOuter: document.getElementById('match-outer'),
    deepRemoval: document.getElementById('deep-removal'),
    enableBgRemoval: document.getElementById('enable-bg-removal'),
    bgColor: document.getElementById('bg-color'),
    bgThreshold: document.getElementById('bg-threshold'),
    outlineColor: document.getElementById('outline-color'),
    algorithm: document.getElementById('algorithm'),
    safety: document.getElementById('safety'),
    bgOnlyOuter: document.getElementById('bg-only-outer'),
    enableInfill: document.getElementById('enable-infill'),
    infillAlpha: document.getElementById('infill-alpha'),
    outWidth: document.getElementById('out-width'),
    outHeight: document.getElementById('out-height'),
    upscaleModel: document.getElementById('upscale-model'),
    upscaleSharpen: document.getElementById('upscale-sharpen')
};

// AI model selection
const MODEL_DESCRIPTIONS = {
    pixel: 'Exact-pixel scaling, no AI. Crisp edges — ideal for pixel art.',
    slim: 'Fastest, smallest download. Softest result.',
    medium: 'Balanced sharpness vs. speed. Good general choice.',
    thick: 'Sharpest result. Largest download, slowest processing.',
    anime: 'AnimeSharp V4 ×2 — sharpener for clean anime & line art. ~32 MB; seconds on GPU (WebGPU), minutes on CPU.',
    restore: 'Real-ESRGAN Restore ×4 — rebuilds detail: deblurs & removes JPEG artifacts. Best for low-quality images. ~5 MB; CPU (~1-2 min).',
    anime6b: 'Real-ESRGAN Anime 6B ×4 — Upscayl\'s "Digital Art" model. Strongest anime restoration. ~18 MB; CPU only (~5-10 min).'
};

if (inputs.upscaleModel) {
    inputs.upscaleModel.addEventListener('change', () => {
        const desc = document.getElementById('upscale-model-desc');
        if (desc) desc.innerHTML = `<em>${MODEL_DESCRIPTIONS[inputs.upscaleModel.value] || ''}</em>`;
    });
}

const upscalerCache = {};

// Unsharp mask: sharpened = original + strength * (original - blurred).
// Separable 5-tap box blur; RGB only, alpha untouched.
function applyUnsharpMask(imgData, amount) {
    const w = imgData.width, h = imgData.height, src = imgData.data;
    const strength = amount * 1.2;
    const r = 2, div = 2 * r + 1;
    const tmp = new Float32Array(w * h * 3);
    const blur = new Float32Array(w * h * 3);
    // horizontal pass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let R = 0, G = 0, B = 0;
            for (let dx = -r; dx <= r; dx++) {
                const xx = Math.min(w - 1, Math.max(0, x + dx));
                const i = (y * w + xx) * 4;
                R += src[i]; G += src[i + 1]; B += src[i + 2];
            }
            const o = (y * w + x) * 3;
            tmp[o] = R / div; tmp[o + 1] = G / div; tmp[o + 2] = B / div;
        }
    }
    // vertical pass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let R = 0, G = 0, B = 0;
            for (let dy = -r; dy <= r; dy++) {
                const yy = Math.min(h - 1, Math.max(0, y + dy));
                const i = (yy * w + x) * 3;
                R += tmp[i]; G += tmp[i + 1]; B += tmp[i + 2];
            }
            const o = (y * w + x) * 3;
            blur[o] = R / div; blur[o + 1] = G / div; blur[o + 2] = B / div;
        }
    }
    // combine (Uint8ClampedArray clamps for us)
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        const b = p * 3;
        src[i] = src[i] + strength * (src[i] - blur[b]);
        src[i + 1] = src[i + 1] + strength * (src[i + 1] - blur[b + 1]);
        src[i + 2] = src[i + 2] + strength * (src[i + 2] - blur[b + 2]);
    }
}

// Live re-apply: sharpening is cheap, so slider changes update the existing result
// without re-running the AI. Debounced to keep dragging smooth on large images.
let sharpenTimer = null;
if (inputs.upscaleSharpen) {
    inputs.upscaleSharpen.addEventListener('input', () => {
        if (!lastUnsharpenedData) return;
        clearTimeout(sharpenTimer);
        sharpenTimer = setTimeout(() => {
            const img = new ImageData(new Uint8ClampedArray(lastUnsharpenedData.data), lastUnsharpenedData.width, lastUnsharpenedData.height);
            const pct = parseInt(inputs.upscaleSharpen.value) || 0;
            if (pct > 0) applyUnsharpMask(img, pct / 100);
            afterCanvas.width = img.width;
            afterCanvas.height = img.height;
            afterCtx.putImageData(img, 0, 0);
            lastProcessedData = img;
        }, 120);
    });
}

function getModelForScale(key, scale) {
    const prefix = { slim: 'ESRGANSlim', medium: 'ESRGANMedium', thick: 'ESRGANThick' }[key];
    if (!prefix) return null;
    return window[prefix + scale + 'x'] || null;
}

function loadImg(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

const vals = {
    strokeWidth: document.getElementById('stroke-width-val'),
    smoothing: document.getElementById('smoothing-val'),
    threshold: document.getElementById('threshold-val'),
    depth: document.getElementById('depth-val'),
    bgThreshold: document.getElementById('bg-threshold-val'),
    bgColor: document.querySelector('#bg-color + .color-val'),
    outlineColor: document.querySelector('#outline-color + .color-val'),
    safety: document.getElementById('safety-val'),
    infillAlpha: document.getElementById('infill-alpha-val'),
    upscaleSharpen: document.getElementById('upscale-sharpen-val')
};

// Event Listeners
uploadBtn.addEventListener('click', () => {
    if (baseImageData) {
        resetToUpload();
    } else {
        imageInput.click();
    }
});

// Tabs State
let currentTab = 'outline';
const tabBtns = document.querySelectorAll('.tab-btn');

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        currentTab = btn.dataset.tab;
        
        // Toggle sidebars
        document.getElementById('outline-sidebar-controls').classList.toggle('hidden', currentTab !== 'outline');
        document.getElementById('upscale-sidebar-controls').classList.toggle('hidden', currentTab !== 'upscale');
        
        // Toggle lower controls
        document.getElementById('outline-lower-controls').classList.toggle('hidden', currentTab !== 'outline');
        document.getElementById('upscale-lower-controls').classList.toggle('hidden', currentTab !== 'upscale');

        // Upload box copy per tab
        const upTitle = document.getElementById('upload-title');
        const upSub = document.getElementById('upload-subtitle');
        if (upTitle && upSub) {
            if (currentTab === 'outline') {
                upTitle.textContent = 'Select or drag an image to begin';
                upSub.style.display = 'none';
            } else {
                upTitle.textContent = 'Drag & Drop or Click';
                upSub.textContent = 'Select an image — or drop several to batch upscale';
                upSub.style.display = '';
            }
        }

        if (batchFiles.length) updateBatchPanelMode();
    });
});

uploadBox.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', handleFile);
processBtn.addEventListener('click', () => {
    if (batchFiles.length) {
        processBatch();
        return;
    }
    if (currentTab === 'outline') {
        processOutline();
    } else {
        processUpscale();
    }
});
applyBtn.addEventListener('click', applyChanges);
downloadBtn.addEventListener('click', downloadImage);

// Drag and drop setup
uploadBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadBox.style.borderColor = 'var(--accent-color)';
    uploadBox.style.background = 'rgba(99, 102, 241, 0.05)';
});
uploadBox.addEventListener('dragleave', () => {
    uploadBox.style.borderColor = 'var(--border-color)';
    uploadBox.style.background = 'transparent';
});
uploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadBox.style.borderColor = 'var(--border-color)';
    uploadBox.style.background = 'transparent';
    if (e.dataTransfer.files.length) {
        handleFile({ target: { files: e.dataTransfer.files } });
    }
});

// Update labels and values
Object.keys(inputs).forEach(key => {
    if (!inputs[key]) return;
    inputs[key].addEventListener('input', () => {
        if (vals[key]) {
            if (key === 'bgColor' || key === 'outlineColor') {
                if (inputs[key].value === '#000000' && key === 'outlineColor') {
                    vals[key].textContent = "Auto-detect";
                } else {
                    vals[key].textContent = inputs[key].value.toUpperCase();
                }
            } else {
                vals[key].textContent = inputs[key].value;
            }
        }
    });
});

// Eyedropper logic
let activePicker = 'outline-color';
inputs.bgColor.addEventListener('click', () => activePicker = 'bg-color');
inputs.outlineColor.addEventListener('click', () => activePicker = 'outline-color');
beforeCanvas.addEventListener('click', pickColor);

function pickColor(e) {
    if (!baseImageData) return;
    const rect = beforeCanvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * (beforeCanvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (beforeCanvas.height / rect.height));

    const pixel = beforeCtx.getImageData(x, y, 1, 1).data;
    const hex = '#' + Array.from(pixel.slice(0, 3)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (activePicker === 'bg-color') {
        inputs.bgColor.value = hex;
        vals.bgColor.textContent = hex.toUpperCase();
        inputs.enableBgRemoval.checked = true;
    } else {
        inputs.outlineColor.value = hex;
        vals.outlineColor.textContent = hex.toUpperCase();
    }
    
    if (currentTab === 'outline') {
        processOutline();
    }
}

function handleFile(e) {
    const files = e.target.files;
    if (!files || !files.length) return;
    if (files.length > 1) {
        enterBatchMode(Array.from(files));
        if (imageInput) imageInput.value = '';
        return;
    }
    exitBatchMode();
    const file = files[0];

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            [beforeCanvas, afterCanvas].forEach(c => {
                c.width = img.width;
                c.height = img.height;
            });

            beforeCtx.clearRect(0, 0, beforeCanvas.width, beforeCanvas.height);
            beforeCtx.drawImage(img, 0, 0);
            baseImageData = beforeCtx.getImageData(0, 0, img.width, img.height);
            
            afterCtx.clearRect(0, 0, afterCanvas.width, afterCanvas.height);
            afterCtx.drawImage(img, 0, 0);
            
            canvasContainer.classList.remove('hidden');
            uploadBox.classList.add('hidden');
            updateStatus(`Loaded ${img.width}x${img.height}`);
            
            if (inputs.outWidth) inputs.outWidth.value = img.width;
            if (inputs.outHeight) inputs.outHeight.value = img.height;
            
            if (currentTab === 'outline') {
                processOutline();
            }
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

function resetToUpload() {
    exitBatchMode();
    baseImageData = null;
    lastProcessedData = null;
    lastUnsharpenedData = null;
    canvasContainer.classList.add('hidden');
    uploadBox.classList.remove('hidden');
    updateStatus('Ready for upload');
    imageInput.value = '';
}

// tfjs's WebGL backend accumulates shader programs & GPU memory per unique image size;
// long batches can degrade or lose the GPU context ("Failed to compile fragment shader" /
// "Failed to link vertex and fragment shaders"). This disposes everything and rebuilds
// the backend so a retry starts from a clean context.
async function resetTfjsBackend() {
    for (const k in upscalerCache) {
        try { upscalerCache[k].dispose(); } catch (e) { /* ignore */ }
        delete upscalerCache[k];
    }
    try {
        if (window.tf) {
            tf.engine().disposeVariables();
            tf.engine().reset();
            await tf.setBackend('webgl');
            await tf.ready();
        }
    } catch (e) {
        console.warn('tfjs backend reset failed:', e);
    }
}

function buildOutlineOptions() {
    return {
        strokeWidth: parseInt(inputs.strokeWidth.value),
        smoothing: parseInt(inputs.smoothing.value),
        threshold: parseFloat(inputs.threshold.value),
        depth: parseInt(inputs.depth.value),
        matchOuter: inputs.matchOuter.checked,
        deepRemoval: inputs.deepRemoval.checked,
        backgroundColor: inputs.enableBgRemoval.checked ? hexToRgb(inputs.bgColor.value) : null,
        backgroundColorThreshold: parseFloat(inputs.bgThreshold.value),
        backgroundOnlyOuter: inputs.bgOnlyOuter.checked,
        outlineColor: hexToRgb(inputs.outlineColor.value),
        algorithm: inputs.algorithm.value,
        safetyThreshold: parseFloat(inputs.safety.value),
        infill: inputs.enableInfill.checked,
        infillAlpha: parseInt(inputs.infillAlpha.value)
    };
}

function processOutline() {
    if (!baseImageData) return;
    updateStatus('Processing...', true);

    setTimeout(() => {
        const startTime = performance.now();
        
        const imageData = new ImageData(
            new Uint8ClampedArray(baseImageData.data),
            baseImageData.width,
            baseImageData.height
        );

        const options = buildOutlineOptions();

        remover.process(imageData, options);

        afterCanvas.width = imageData.width;
        afterCanvas.height = imageData.height;
        afterCtx.putImageData(imageData, 0, 0);
        lastProcessedData = imageData;

        const duration = Math.round(performance.now() - startTime);
        updateStatus(`Processed in ${duration}ms`);
    }, 10);
}

async function processUpscale() {
    if (!baseImageData) return;
    
    const newWidth = parseInt(inputs.outWidth.value) || baseImageData.width;
    const newHeight = parseInt(inputs.outHeight.value) || baseImageData.height;
    const modelKey = inputs.upscaleModel ? inputs.upscaleModel.value : 'slim';
    const pixelPerfect = modelKey === 'pixel';

    // Nearest Neighbor (No AI)
    if (pixelPerfect) {
        updateStatus('Resizing (Nearest Neighbor)...', true);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = baseImageData.width;
        tempCanvas.height = baseImageData.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(baseImageData, 0, 0);

        afterCanvas.width = newWidth;
        afterCanvas.height = newHeight;
        afterCtx.imageSmoothingEnabled = false;
        afterCtx.clearRect(0, 0, newWidth, newHeight);
        afterCtx.drawImage(tempCanvas, 0, 0, baseImageData.width, baseImageData.height, 0, 0, newWidth, newHeight);
        lastProcessedData = afterCtx.getImageData(0, 0, newWidth, newHeight);
        updateStatus('Resize complete.');
        return;
    }

    // AI Upscaling
    updateStatus('AI Upscaling... (May take a moment to download model)', true);
    const progressBarContainer = document.getElementById('upscale-progress-container');
    const progressBar = document.getElementById('upscale-progress-bar');
    progressBarContainer.classList.remove('hidden');
    progressBar.style.width = '0%';

    try {
        // --- ARTIFACT REDUCTION ALGORITHM ---
        // 1. Extract Alpha Channel Mask
        const alphaCanvas = document.createElement('canvas');
        alphaCanvas.width = baseImageData.width;
        alphaCanvas.height = baseImageData.height;
        const alphaCtx = alphaCanvas.getContext('2d');
        const alphaData = alphaCtx.createImageData(baseImageData.width, baseImageData.height);
        for(let i=0; i<baseImageData.data.length; i+=4) {
            const a = baseImageData.data[i+3];
            alphaData.data[i] = a;
            alphaData.data[i+1] = a;
            alphaData.data[i+2] = a;
            alphaData.data[i+3] = 255;
        }
        alphaCtx.putImageData(alphaData, 0, 0);

        // 2. Perform "Alpha Bleed" to extend edge colors into transparent areas
        // This prevents the AI from creating dark/light halos where colors meet transparency
        function bleedImage(imgData, passes = 8) {
            const w = imgData.width;
            const h = imgData.height;
            const out = new Uint8ClampedArray(imgData.data);
            for (let p = 0; p < passes; p++) {
                const temp = new Uint8ClampedArray(out);
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const i = (y * w + x) * 4;
                        if (out[i + 3] === 0) { // If transparent
                            let r=0, g=0, b=0, count=0;
                            for (let dy = -1; dy <= 1; dy++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    const nx = x + dx;
                                    const ny = y + dy;
                                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                        const ni = (ny * w + nx) * 4;
                                        if (out[ni + 3] > 0) { // Has color
                                            r += out[ni];
                                            g += out[ni + 1];
                                            b += out[ni + 2];
                                            count++;
                                        }
                                    }
                                }
                            }
                            if (count > 0) {
                                temp[i] = r / count;
                                temp[i + 1] = g / count;
                                temp[i + 2] = b / count;
                                temp[i + 3] = 1; // Mark as filled
                            }
                        }
                    }
                }
                out.set(temp);
            }
            // Make fully opaque for AI
            for (let i = 0; i < out.length; i += 4) {
                out[i + 3] = 255;
            }
            return new ImageData(out, w, h);
        }

        const bledData = bleedImage(baseImageData, 8);
        const rgbCanvas = document.createElement('canvas');
        rgbCanvas.width = baseImageData.width;
        rgbCanvas.height = baseImageData.height;
        rgbCanvas.getContext('2d').putImageData(bledData, 0, 0);

        // 3. Upscale the Solid RGB Image
        // Plan AI passes so the AI output is >= the target size. Stretching a 2x AI
        // result up to 4x with canvas interpolation re-blurs everything the model
        // sharpened; instead we pick the model scale that covers the target (x2/x3/x4,
        // extra x2 passes beyond that) and only ever DOWNscale to the exact size.
        const onnxCfg = (window.OnnxUpscaler && window.OnnxUpscaler.models[modelKey]) || null;
        const scaleNeeded = Math.max(newWidth / baseImageData.width, newHeight / baseImageData.height, 1);
        const stepScale = onnxCfg ? onnxCfg.scale : 2;
        const passes = [];
        let remaining = scaleNeeded;
        const firstScale = onnxCfg ? stepScale : (remaining <= 2 ? 2 : (remaining <= 3 ? 3 : 4));
        passes.push(firstScale);
        remaining /= firstScale;
        while (remaining > 1) {
            passes.push(stepScale);
            remaining /= stepScale;
        }

        let workCanvas = rgbCanvas;
        for (let p = 0; p < passes.length; p++) {
            const scale = passes[p];
            const onProgress = (percent) => {
                const overall = (p + percent) / passes.length;
                progressBar.style.width = `${Math.round(overall * 100)}%`;
            };

            if (onnxCfg) {
                workCanvas = await window.OnnxUpscaler.upscaleOnce(modelKey, workCanvas, {
                    progress: onProgress,
                    status: (text) => updateStatus(text, true)
                });
                continue;
            }

            const model = getModelForScale(modelKey, scale);
            if (!model) {
                throw new Error(`Model "${modelKey}" x${scale} is not loaded (script tag missing or CDN blocked).`);
            }
            const cacheKey = `${modelKey}_x${scale}`;
            if (!upscalerCache[cacheKey]) {
                upscalerCache[cacheKey] = new window.Upscaler({ model });
            }
            const upscaledImgDataUrl = await upscalerCache[cacheKey].upscale(workCanvas, {
                patchSize: 64,
                padding: 8, // generous padding avoids soft seams at patch borders
                progress: onProgress
            });
            const img = await loadImg(upscaledImgDataUrl);
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            workCanvas = c;
        }

        afterCanvas.width = newWidth;
        afterCanvas.height = newHeight;
        afterCtx.imageSmoothingEnabled = true;
        afterCtx.imageSmoothingQuality = 'high';
        afterCtx.clearRect(0, 0, newWidth, newHeight);

        // Draw AI Upscaled RGB (downscale-or-equal — never an up-stretch)
        afterCtx.drawImage(workCanvas, 0, 0, workCanvas.width, workCanvas.height, 0, 0, newWidth, newHeight);
        const finalImgData = afterCtx.getImageData(0, 0, newWidth, newHeight);

        // Scale the Alpha Mask using standard high-quality interpolation
        const scaledAlphaCanvas = document.createElement('canvas');
        scaledAlphaCanvas.width = newWidth;
        scaledAlphaCanvas.height = newHeight;
        const scaledAlphaCtx = scaledAlphaCanvas.getContext('2d');
        scaledAlphaCtx.imageSmoothingEnabled = true;
        scaledAlphaCtx.imageSmoothingQuality = 'high';
        scaledAlphaCtx.drawImage(alphaCanvas, 0, 0, newWidth, newHeight);
        const finalAlphaData = scaledAlphaCtx.getImageData(0, 0, newWidth, newHeight);

        // 4. Recombine Alpha Mask with AI RGB
        for(let i=0; i<finalImgData.data.length; i+=4) {
            finalImgData.data[i+3] = finalAlphaData.data[i]; // Apply grayscale mask to alpha channel
        }

        // 5. Optional post-AI sharpen (cache the unsharpened result so the slider can re-apply live)
        lastUnsharpenedData = new ImageData(new Uint8ClampedArray(finalImgData.data), newWidth, newHeight);
        const sharpenPct = inputs.upscaleSharpen ? (parseInt(inputs.upscaleSharpen.value) || 0) : 0;
        if (sharpenPct > 0) applyUnsharpMask(finalImgData, sharpenPct / 100);

        afterCtx.putImageData(finalImgData, 0, 0);

        lastProcessedData = afterCtx.getImageData(0, 0, newWidth, newHeight);
        updateStatus('AI Upscaling complete.');
        progressBarContainer.classList.add('hidden');
        
    } catch (error) {
        console.error(error);
        updateStatus(error && error.message ? `Upscale failed: ${error.message}` : 'Error during AI upscaling.');
        progressBarContainer.classList.add('hidden');
    }
}

// ===== Batch upscaling =====
// Reuses the single-image pipeline (processUpscale) per file: same model, sharpen,
// alpha handling and progress bar — then zips the results with original names.
let batchFiles = [];
let batchZipBlob = null;
let batchRunning = false;

function renderBatchList() {
    const list = document.getElementById('batch-list');
    if (!list) return;
    list.innerHTML = '';
    batchFiles.forEach(item => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:0.4rem 0.6rem; background:rgba(255,255,255,0.04); border-radius:6px; font-size:0.85rem;';
        const name = document.createElement('span');
        name.textContent = item.file.name + (item.w ? ' (' + item.w + '\u00d7' + item.h + ')' : '');
        name.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        const st = document.createElement('span');
        st.textContent = item.status;
        st.style.cssText = 'color:var(--text-secondary); flex-shrink:0;';
        if (item.status === 'done') st.style.color = 'var(--accent-color)';
        if (item.status.indexOf('failed') === 0) st.style.color = '#e05555';
        row.appendChild(name);
        row.appendChild(st);
        list.appendChild(row);
    });
}

function updateBatchPanelMode() {
    const row = document.getElementById('batch-scale-row');
    const hint = document.getElementById('batch-hint');
    if (!row || !hint) return;
    const outline = currentTab === 'outline';
    row.style.display = outline ? 'none' : 'flex';
    hint.textContent = outline
        ? 'Outline settings come from the sidebar — press Process to start, results download as one ZIP.'
        : 'Model & Sharpen come from the sidebar — press Process to start, results download as one ZIP.';
}

function enterBatchMode(files) {
    batchFiles = files.map(f => ({ file: f, status: 'queued' }));
    batchZipBlob = null;
    baseImageData = null;
    lastProcessedData = null;
    lastUnsharpenedData = null;
    canvasContainer.classList.add('hidden');
    uploadBox.classList.add('hidden');
    const panel = document.getElementById('batch-panel');
    if (panel) panel.classList.remove('hidden');
    updateBatchPanelMode();
    renderBatchList();
    updateStatus(batchFiles.length + ' files queued — press Process');
}

function exitBatchMode() {
    batchFiles = [];
    batchZipBlob = null;
    const panel = document.getElementById('batch-panel');
    if (panel) panel.classList.add('hidden');
}

function loadImageFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load ' + file.name)); };
        img.src = url;
    });
}

function canvasToBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function readImageSize(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
        img.src = url;
    });
}

async function processBatch() {
    if (batchRunning || !batchFiles.length) return;
    if (typeof JSZip === 'undefined') {
        updateStatus('JSZip failed to load \u2014 check your connection.');
        return;
    }
    batchRunning = true;
    batchZipBlob = null;
    const outlineMode = currentTab === 'outline';
    const factor = parseInt(document.getElementById('batch-scale').value) || 2;
    const deliverySel = document.getElementById('batch-delivery');
    const folderMode = deliverySel && deliverySel.value === 'folder';
    let dirHandle = null;
    if (folderMode) {
        if (window.showDirectoryPicker) {
            try {
                // Must happen right after the Process click (user activation)
                dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            } catch (e) {
                batchRunning = false;
                if (e && e.name === 'AbortError') {
                    updateStatus('Folder selection cancelled.');
                } else {
                    // e.g. SecurityError: embedded/sandboxed pages (like a preview iframe) can't open the picker
                    updateStatus('Folder access blocked here (' + (e && e.name ? e.name : 'error') + ') \u2014 open the tool in its own tab, or use ZIP mode.');
                }
                return;
            }
        } else {
            // No API: only per-file downloads are possible. Ask upfront instead of surprising mid-batch.
            const goOn = confirm('This browser can\u2019t write to a folder directly (Brave: enable brave://flags/#file-system-access-api).\n\nContinue with one download per file? (Cancel to stop \u2014 switch "Save as" to ZIP instead.)');
            if (!goOn) {
                batchRunning = false;
                updateStatus('Batch cancelled \u2014 use ZIP mode, or enable the folder API.');
                return;
            }
            updateStatus('No folder API \u2014 each file will download individually.');
        }
    }
    const zip = folderMode ? null : new JSZip();
    let ok = 0;
    let skipped = 0;

    // Sort by input dimensions so same-sized files run back-to-back — tfjs compiles
    // WebGL shaders per unique size, so grouping avoids repeated recompilation.
    if (!outlineMode) {
        updateStatus('Reading image sizes\u2026', true);
        for (const item of batchFiles) {
            try {
                const dim = await readImageSize(item.file);
                item.w = dim.w; item.h = dim.h;
            } catch (e) {
                item.w = 0; item.h = 0; // unreadable — sorts first, fails in the main loop with a proper message
            }
        }
        batchFiles.sort((a, b) => (a.w * a.h - b.w * b.h) || (a.w - b.w) || a.file.name.localeCompare(b.file.name));
        renderBatchList();
    }

    for (let n = 0; n < batchFiles.length; n++) {
        const item = batchFiles[n];
        const outName = item.file.name.replace(/\.[^.]+$/, '') + '.png';
        // Restart support: skip files already present in the target folder
        if (dirHandle) {
            try {
                await dirHandle.getFileHandle(outName);
                item.status = 'skipped (already in folder)';
                skipped++;
                renderBatchList();
                continue;
            } catch (e) { /* not there yet — process it */ }
        }
        item.status = 'processing (' + (n + 1) + '/' + batchFiles.length + ')\u2026';
        renderBatchList();
        try {
            const img = await loadImageFile(item.file);
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const cctx = c.getContext('2d');
            cctx.drawImage(img, 0, 0);
            baseImageData = cctx.getImageData(0, 0, img.width, img.height);
            lastProcessedData = null;
            if (outlineMode) {
                const imageData = new ImageData(new Uint8ClampedArray(baseImageData.data), img.width, img.height);
                remover.process(imageData, buildOutlineOptions());
                lastProcessedData = imageData;
                await new Promise(r => setTimeout(r, 0)); // keep the UI responsive between files
            } else {
                inputs.outWidth.value = img.width * factor;
                inputs.outHeight.value = img.height * factor;
                await processUpscale();
                if (!lastProcessedData) {
                    // GPU context likely degraded mid-batch — rebuild the backend and retry once
                    item.status = 'retrying\u2026';
                    renderBatchList();
                    await resetTfjsBackend();
                    await processUpscale();
                }
            }
            if (!lastProcessedData) throw new Error(statusBadge ? statusBadge.textContent : 'processing failed');
            const outC = document.createElement('canvas');
            outC.width = lastProcessedData.width;
            outC.height = lastProcessedData.height;
            outC.getContext('2d').putImageData(lastProcessedData, 0, 0);
            const blob = await canvasToBlob(outC);
            if (dirHandle) {
                const fh = await dirHandle.getFileHandle(outName, { create: true });
                const w = await fh.createWritable();
                await w.write(blob);
                await w.close();
                item.status = 'saved';
            } else if (folderMode) {
                // No File System Access API — fall back to a per-file download
                const link = document.createElement('a');
                link.download = outName;
                link.href = URL.createObjectURL(blob);
                link.click();
                setTimeout(() => URL.revokeObjectURL(link.href), 30000);
                item.status = 'downloaded';
            } else {
                zip.file(outName, blob);
                item.status = 'done';
            }
            ok++;
        } catch (err) {
            console.error(err);
            item.status = 'failed: ' + String(err && err.message ? err.message : 'error').slice(0, 60);
        }
        renderBatchList();
    }
    baseImageData = null;
    lastProcessedData = null;
    lastUnsharpenedData = null;
    if (ok > 0 && !folderMode) {
        updateStatus('Zipping\u2026', true);
        batchZipBlob = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.download = (outlineMode ? 'outlined_' : 'upscaled_' + factor + 'x_') + Date.now() + '.zip';
        link.href = URL.createObjectURL(batchZipBlob);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 30000);
        updateStatus('Batch complete: ' + ok + '/' + batchFiles.length + ' files \u2014 ZIP downloaded.');
    } else if (ok > 0 || skipped > 0) {
        updateStatus('Batch complete: ' + ok + ' saved' + (skipped ? ', ' + skipped + ' already done' : '') + ' of ' + batchFiles.length + '.');
    } else {
        updateStatus('Batch failed \u2014 no files processed.');
    }
    batchRunning = false;
}

function applyChanges() {
    if (!lastProcessedData) return;
    baseImageData = lastProcessedData;
    lastUnsharpenedData = null; // result is now the base; slider applies to the NEXT run
    beforeCanvas.width = baseImageData.width;
    beforeCanvas.height = baseImageData.height;
    beforeCtx.putImageData(baseImageData, 0, 0);
    updateStatus('Changes applied! New base established.');
    
    beforeCanvas.style.transition = 'none';
    beforeCanvas.style.filter = 'brightness(1.5)';
    setTimeout(() => {
        beforeCanvas.style.transition = 'filter 0.3s';
        beforeCanvas.style.filter = 'none';
    }, 50);
}

function downloadImage() {
    if (batchZipBlob) {
        const link = document.createElement('a');
        link.download = 'upscaled_batch.zip';
        link.href = URL.createObjectURL(batchZipBlob);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 30000);
        return;
    }
    if (!lastProcessedData) return;
    const link = document.createElement('a');
    link.download = `cleaned_${Date.now()}.png`;
    link.href = afterCanvas.toDataURL('image/png');
    link.click();
}

function updateStatus(text, isWork = false) {
    if (!statusBadge) return;
    statusBadge.textContent = text;
    statusBadge.style.color = isWork ? 'var(--accent-color)' : 'var(--text-secondary)';
}

function hexToRgb(hex) {
    if (!hex) return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b, a: 255 };
}
