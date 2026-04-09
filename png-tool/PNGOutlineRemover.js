/**
 * PNGOutlineRemover.js
 * A standalone implementation of the outline removal algorithm from onlinepngtools.com
 * Features: Geometric Erosion, Perceptual Deep Removal (DeltaE), and Smoothing.
 */

class PNGOutlineRemover {
    constructor() {
        this.cache = {
            circleMasks: {},
            smoothingMasks: {}
        };
    }

    /**
     * Main processing function
     * @param {ImageData} imageData - The canvas image data to process
     * @param {Object} options - Processing options
     * @param {number} options.strokeWidth - Thickness of the outline to remove (geometric)
     * @param {number} options.smoothing - Level of anti-aliasing to apply
     * @param {boolean} options.deepRemoval - Whether to perform color-based cleanup
     * @param {number} options.threshold - Color difference threshold (0-100)
     * @param {number} options.depth - Search depth for deep removal
     * @param {string} options.algorithm - 'visual' (DeltaE) or 'euclidean' (RGB)
     * @param {number} options.safetyThreshold - Tolerance for Selective Erosion (0-100)
     * @param {Object} options.backgroundColor - {r,g,b,a} background color to remove first
     * @param {number} options.backgroundColorThreshold - Tolerance for background removal (0-100)
     * @param {boolean} options.backgroundOnlyOuter - Only remove background connected to edges
     * @param {boolean} options.infill - Whether to fill removed pixels with neighboring colors
     * @param {number} options.infillAlpha - Alpha value for infilled pixels (0-255)
     * @param {boolean} options.matchOuter - Only remove pixels connected to the image border
     */
    process(imageData, options) {
        const { width, height, data } = imageData;
        const grid = this._prepareGrid(imageData);
        const algorithm = options.algorithm || 'visual';

        // 0. Remove Background
        if (options.backgroundColor) {
            this._removeBackground(grid, options.backgroundColor, options.backgroundColorThreshold || 10, width, height, algorithm, options.backgroundOnlyOuter);
        }

        const { transpCoords, notTranspCoords } = this._classifyPixels(grid, width, height);

        // 1. Identify edge pixels
        let targetTransp = transpCoords;
        if (options.matchOuter) {
            targetTransp = this._getOuterTransparency(grid, transpCoords, width, height);
        }
        
        const edgePixels = this._getEdgePixels(notTranspCoords, targetTransp);

        // 2. Erosion (Advanced Outline Cleanup)
        let removedPixels = [];
        const outlineColor = options.outlineColor || this._autoDetectOutlineColor(grid, edgePixels);
        const targetRef = algorithm === 'visual' ? this._rgb2lab(outlineColor) : outlineColor;

        if (options.strokeWidth > 0) {
            const erosionResult = this._erode(
                grid, 
                edgePixels, 
                options.strokeWidth, 
                notTranspCoords, 
                transpCoords,
                targetRef,
                options.safetyThreshold,
                algorithm
            );
            removedPixels = erosionResult.removed;
        } else {
            removedPixels = edgePixels;
        }

        // 3. Deep Removal
        if (options.deepRemoval && (options.strokeWidth > 0 || options.outlineColor)) {
            // Seed only with pixels that actually match the outline color
            const detectionTarget = (options.strokeWidth > 0 ? removedPixels : edgePixels)
                .filter(p => this._getDistance(targetRef, grid[p.y][p.x], algorithm) <= (options.threshold || 15));

            const deepRemoved = this._deepRemoval(
                grid, 
                detectionTarget, 
                targetRef,
                options.depth, 
                options.threshold,
                transpCoords,
                notTranspCoords,
                algorithm
            );
            removedPixels = [...new Set([...removedPixels, ...deepRemoved])];
        }

        // Apply removals or Infill to grid
        const removedMap = new Set(removedPixels.map(p => `${p.x},${p.y}`));

        removedPixels.forEach(p => {
            const pixel = grid[p.y][p.x];
            
            if (options.infill) {
                // Find nearest NOT removed neighbor
                const neighbor = this._findSafeNeighbor(grid, p.x, p.y, removedMap, width, height);
                if (neighbor) {
                    pixel.r = neighbor.r;
                    pixel.g = neighbor.g;
                    pixel.b = neighbor.b;
                    pixel.a = options.infillAlpha !== undefined ? options.infillAlpha : 255;
                } else {
                    pixel.a = 0; // Fallback to transparent
                }
            } else {
                pixel.r = 0; pixel.g = 0; pixel.b = 0; pixel.a = 0;
            }
            
            // Update mapping for smoothing loop
            if (notTranspCoords[p.x] && notTranspCoords[p.x][p.y]) {
                delete notTranspCoords[p.x][p.y];
                if (!transpCoords[p.x]) transpCoords[p.x] = {};
                transpCoords[p.x][p.y] = pixel;
            }
        });

        // 4. Smoothing
        if (options.smoothing > 0) {
            const newEdges = this._getEdgePixels(notTranspCoords, transpCoords);
            this._smooth(grid, newEdges, options.smoothing, transpCoords);
        }

        // Write back to ImageData
        this._writeGridToImageData(grid, imageData);
        return imageData;
    }

    _removeBackground(grid, targetColor, threshold, width, height, algorithm, onlyOuter) {
        const targetRef = algorithm === 'visual' ? this._rgb2lab(targetColor) : targetColor;
        
        if (onlyOuter) {
            const queue = [];
            const visited = new Uint8Array(width * height);
            
            // Seed with border pixels
            for (let x = 0; x < width; x++) {
                queue.push({x, y: 0});
                queue.push({x, y: height - 1});
            }
            for (let y = 1; y < height - 1; y++) {
                queue.push({x: 0, y});
                queue.push({x: width - 1, y});
            }

            while (queue.length > 0) {
                const { x, y } = queue.shift();
                const idx = y * width + x;
                if (visited[idx]) continue;
                visited[idx] = 1;

                const pixel = grid[y][x];
                if (pixel.a > 0) {
                    const diff = this._getDistance(targetRef, pixel, algorithm);
                    if (diff <= threshold) {
                        pixel.r = 0; pixel.g = 0; pixel.b = 0; pixel.a = 0;
                        
                        // Add neighbors to queue
                        const neighbors = [{x:x+1, y}, {x:x-1, y}, {x, y:y+1}, {x, y:y-1}];
                        for (const n of neighbors) {
                            if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height && !visited[n.y * width + n.x]) {
                                queue.push(n);
                            }
                        }
                    }
                }
            }
        } else {
            // Global removal (original logic)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const pixel = grid[y][x];
                    if (pixel.a > 0) {
                        const diff = this._getDistance(targetRef, pixel, algorithm);
                        if (diff <= threshold) {
                            pixel.r = 0; pixel.g = 0; pixel.b = 0; pixel.a = 0;
                        }
                    }
                }
            }
        }
    }

    _prepareGrid(imageData) {
        const { width, height, data } = imageData;
        const grid = [];
        for (let y = 0; y < height; y++) {
            grid[y] = [];
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                grid[y][x] = {
                    r: data[i],
                    g: data[i + 1],
                    b: data[i + 2],
                    a: data[i + 3],
                    x, y
                };
            }
        }
        return grid;
    }

    _classifyPixels(grid, width, height) {
        const transpCoords = {};
        const notTranspCoords = {};

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const pixel = grid[y][x];
                const target = pixel.a === 0 ? transpCoords : notTranspCoords;
                if (!target[x]) target[x] = {};
                target[x][y] = pixel;
            }
        }
        return { transpCoords, notTranspCoords };
    }

    _getOuterTransparency(grid, transpCoords, width, height) {
        const outer = {};
        const queue = [];
        const visited = new Set();

        // Seed with border pixels that are transparent
        for (let x = 0; x < width; x++) {
            if (transpCoords[x]?.[0]) queue.push({x, y: 0});
            if (transpCoords[x]?.[height-1]) queue.push({x, y: height-1});
        }
        for (let y = 1; y < height - 1; y++) {
            if (transpCoords[0]?.[y]) queue.push({x: 0, y});
            if (transpCoords[width-1]?.[y]) queue.push({x: width-1, y});
        }

        while (queue.length > 0) {
            const { x, y } = queue.shift();
            const key = `${x},${y}`;
            if (visited.has(key)) continue;
            visited.add(key);

            if (!outer[x]) outer[x] = {};
            outer[x][y] = transpCoords[x][y];

            // Neighbors
            const neighbors = [
                {x: x+1, y}, {x: x-1, y}, {x, y: y+1}, {x, y: y-1}
            ];
            for (const n of neighbors) {
                if (transpCoords[n.x]?.[n.y] && !visited.has(`${n.x},${n.y}`)) {
                    queue.push(n);
                }
            }
        }
        return outer;
    }

    _getEdgePixels(notTranspCoords, targetTransp) {
        const edges = [];
        for (const xStr in notTranspCoords) {
            const x = parseInt(xStr);
            for (const yStr in notTranspCoords[x]) {
                const y = parseInt(yStr);
                // Check neighbors in targetTransp
                if (targetTransp[x+1]?.[y] || targetTransp[x-1]?.[y] || targetTransp[x]?.[y+1] || targetTransp[x]?.[y-1]) {
                    edges.push({x, y});
                }
            }
        }
        return edges;
    }

    _erode(grid, edgePixels, radius, notTranspCoords, transpCoords, targetRef, safetyThreshold, algorithm) {
        const mask = this._getCircleMask(radius);
        const removed = [];
        const width = grid[0].length;
        const height = grid.length;
        const visited = new Uint8Array(width * height);

        edgePixels.forEach(edge => {
            const startX = edge.x - radius;
            const startY = edge.y - radius;
            for (let my = 0; my < mask.length; my++) {
                for (let mx = 0; mx < mask[my].length; mx++) {
                    if (mask[my][mx] === 0) {
                        const px = startX + mx;
                        const py = startY + my;
                        if (px >= 0 && px < width && py >= 0 && py < height) {
                            const idx = py * width + px;
                            if (!visited[idx] && notTranspCoords[px]?.[py]) {
                                // SAFETY CHECK: Only erode if color matches target or if safety is 100
                                if (safetyThreshold >= 100 || this._getDistance(targetRef, notTranspCoords[px][py], algorithm) <= safetyThreshold) {
                                    visited[idx] = 1;
                                    removed.push({x: px, y: py});
                                }
                            }
                        }
                    }
                }
            }
        });

        return { removed };
    }

    _findSafeNeighbor(grid, x, y, removedMap, width, height) {
        // Spiral or simple search for nearest neighbor NOT in removedMap and NOT transparent
        for (let r = 1; r < 5; r++) { // Search up to 5px radius
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const pixel = grid[ny][nx];
                        if (pixel.a > 0 && !removedMap.has(`${nx},${ny}`)) {
                            return pixel;
                        }
                    }
                }
            }
        }
        return null;
    }

    _deepRemoval(grid, startPixels, targetRef, depth, threshold, transpCoords, notTranspCoords, algorithm) {
        const queue = startPixels.map(p => ({...p, d: 0}));
        const visited = new Set(startPixels.map(p => `${p.x},${p.y}`));
        const removed = [];
        const width = grid[0].length;
        const height = grid.length;

        while (queue.length > 0) {
            const { x, y, d } = queue.shift();
            if (d >= depth) continue;

            const neighbors = [
                {x: x+1, y}, {x: x-1, y}, {x, y: y+1}, {x, y: y-1}
            ];

            for (const n of neighbors) {
                const key = `${n.x},${n.y}`;
                if (n.x >= 0 && n.x < width && n.y >= 0 && n.y < height && !visited.has(key)) {
                    visited.add(key);
                    const pixel = grid[n.y][n.x];
                    if (pixel.a > 0) {
                        const diff = this._getDistance(targetRef, pixel, algorithm);
                        
                        if (diff <= threshold) {
                            removed.push(n);
                            queue.push({...n, d: d + 1});
                        }
                    }
                }
            }
        }
        return removed;
    }

    _smooth(grid, edgePixels, radius, transpCoords) {
        const mask = this._getSmoothingMask(radius);
        const width = grid[0].length;
        const height = grid.length;
        const offset = Math.floor(mask.length / 2);

        edgePixels.forEach(edge => {
            for (let my = 0; my < mask.length; my++) {
                for (let mx = 0; mx < mask[my].length; mx++) {
                    const weight = mask[my][mx];
                    if (weight < 255) {
                        const px = edge.x + (mx - offset);
                        const py = edge.y + (my - offset);
                        if (px >= 0 && px < width && py >= 0 && py < height) {
                            const pixel = grid[py][px];
                            if (pixel.a > 0) {
                                // Apply transparency based on mask weight
                                pixel.a = Math.min(pixel.a, weight);
                            }
                        }
                    }
                }
            }
        });
    }

    _getCircleMask(radius) {
        if (this.cache.circleMasks[radius]) return this.cache.circleMasks[radius];
        const size = radius * 2 + 1;
        const mask = Array.from({ length: size }, () => Array(size).fill(255));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dist = Math.sqrt((x - radius) ** 2 + (y - radius) ** 2);
                if (dist <= radius) mask[y][x] = 0;
            }
        }
        this.cache.circleMasks[radius] = mask;
        return mask;
    }

    _getSmoothingMask(radius) {
        if (this.cache.smoothingMasks[radius]) return this.cache.smoothingMasks[radius];
        const size = radius * 2 + 1;
        const mask = Array.from({ length: size }, () => Array(size).fill(255));
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dist = Math.sqrt((x - radius) ** 2 + (y - radius) ** 2);
                if (dist <= radius) {
                    mask[y][x] = Math.floor(255 * (dist / radius));
                }
            }
        }
        this.cache.smoothingMasks[radius] = mask;
        return mask;
    }

    _autoDetectOutlineColor(grid, removedPixels) {
        // Average color of pixels marked for removal
        if (removedPixels.length === 0) return { r: 0, g: 0, b: 0, a: 255 };
        let r = 0, g = 0, b = 0, a = 0;
        removedPixels.forEach(p => {
            const pixel = grid[p.y][p.x];
            r += pixel.r;
            g += pixel.g;
            b += pixel.b;
            a += pixel.a;
        });
        const len = removedPixels.length;
        return { 
            r: Math.round(r / len), 
            g: Math.round(g / len), 
            b: Math.round(b / len), 
            a: Math.round(a / len) 
        };
    }

    _getDistance(targetRef, pixel, algorithm) {
        if (algorithm === 'visual') {
            const pixelLab = this._rgb2lab(pixel);
            return this._deltaE(targetRef, pixelLab); // 0-100
        } else {
            const dr = targetRef.r - pixel.r;
            const dg = targetRef.g - pixel.g;
            const db = targetRef.b - pixel.b;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db);
            return (dist / 441.67) * 100; // Normalized to 0-100
        }
    }

    // Color conversion utilities
    _rgb2lab(color) {
        let r = color.r / 255, g = color.g / 255, b = color.b / 255;
        r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
        g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
        b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

        let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
        let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.00000;
        let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

        x = x > 0.008856 ? Math.pow(x, 1/3) : (7.787 * x) + (16/116);
        y = y > 0.008856 ? Math.pow(y, 1/3) : (7.787 * y) + (16/116);
        z = z > 0.008856 ? Math.pow(z, 1/3) : (7.787 * z) + (16/116);

        return [(116 * y) - 16, 500 * (x - y), 200 * (y - z)];
    }

    _deltaE(labA, labB) {
        const deltaL = labA[0] - labB[0];
        const deltaA = labA[1] - labB[1];
        const deltaB = labA[2] - labB[2];
        const c1 = Math.sqrt(labA[1] * labA[1] + labA[2] * labA[2]);
        const c2 = Math.sqrt(labB[1] * labB[1] + labB[2] * labB[2]);
        const deltaC = c1 - c2;
        let deltaH = deltaA * deltaA + deltaB * deltaB - deltaC * deltaC;
        deltaH = deltaH < 0 ? 0 : Math.sqrt(deltaH);
        const sc = 1.0 + 0.045 * c1;
        const sh = 1.0 + 0.015 * c1;
        const i = deltaL * deltaL + (deltaC / sc) ** 2 + (deltaH / sh) ** 2;
        return i < 0 ? 0 : Math.sqrt(i);
    }

    _writeGridToImageData(grid, imageData) {
        const { width, height, data } = imageData;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const pixel = grid[y][x];
                data[i] = pixel.r;
                data[i+1] = pixel.g;
                data[i+2] = pixel.b;
                data[i+3] = pixel.a;
            }
        }
    }
}
