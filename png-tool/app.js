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
    infillAlpha: document.getElementById('infill-alpha')
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

uploadBox.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', handleFile);
processBtn.addEventListener('click', processImage);
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
    processImage();
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
            processImage();
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

function processImage() {
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
        afterCtx.putImageData(imageData, 0, 0);
        lastProcessedData = imageData;

        const duration = Math.round(performance.now() - startTime);
        updateStatus(`Processed in ${duration}ms`);
    }, 10);
}

function applyChanges() {
    if (!lastProcessedData) return;
    baseImageData = lastProcessedData;
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
