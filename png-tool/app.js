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
    upscalePixelPerfect: document.getElementById('upscale-pixel-perfect')
};

const vals = {
    strokeWidth: document.getElementById('stroke-width-val'),
    smoothing: document.getElementById('smoothing-val'),
    threshold: document.getElementById('threshold-val'),
    depth: document.getElementById('depth-val'),
    bgThreshold: document.getElementById('bg-threshold-val'),
    bgColor: document.querySelector('#bg-color + .color-val'),
    outlineColor: document.querySelector('#outline-color + .color-val'),
    safety: document.getElementById('safety-val'),
    infillAlpha: document.getElementById('infill-alpha-val')
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
    });
});

uploadBox.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', handleFile);
processBtn.addEventListener('click', () => {
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
    const file = e.target.files[0];
    if (!file) return;

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
    baseImageData = null;
    lastProcessedData = null;
    canvasContainer.classList.add('hidden');
    uploadBox.classList.remove('hidden');
    updateStatus('Ready for upload');
    imageInput.value = '';
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

        const options = {
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
    const pixelPerfect = inputs.upscalePixelPerfect.checked;

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
        const upscaler = new window.Upscaler();
        const upscaledImgDataUrl = await upscaler.upscale(rgbCanvas, {
            patchSize: 64, 
            padding: 2,
            progress: (percent) => {
                progressBar.style.width = `${Math.round(percent * 100)}%`;
            }
        });

        const img = new Image();
        img.onload = () => {
            afterCanvas.width = newWidth;
            afterCanvas.height = newHeight;
            afterCtx.imageSmoothingEnabled = true;
            afterCtx.imageSmoothingQuality = 'high';
            afterCtx.clearRect(0, 0, newWidth, newHeight);
            
            // Draw AI Upscaled RGB
            afterCtx.drawImage(img, 0, 0, img.width, img.height, 0, 0, newWidth, newHeight);
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
            afterCtx.putImageData(finalImgData, 0, 0);
            
            lastProcessedData = afterCtx.getImageData(0, 0, newWidth, newHeight);
            updateStatus('AI Upscaling complete.');
            progressBarContainer.classList.add('hidden');
        };
        img.src = upscaledImgDataUrl;
        
    } catch (error) {
        console.error(error);
        updateStatus('Error during AI upscaling.');
        progressBarContainer.classList.add('hidden');
    }
}

function applyChanges() {
    if (!lastProcessedData) return;
    baseImageData = lastProcessedData;
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
