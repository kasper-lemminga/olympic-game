
// Helper for Drawing Greenhouses (Reusable for Split Passes)

// Helper for Drawing Greenhouses (PixiJS Refactor)

// --- GLOBAL DRAWING PRIMITIVES ---
// --- GLOBAL DRAWING PRIMITIVES ---
window.drawPixiPolygon = (g, pts, color) => {
    g.beginFill(color);
    g.drawPolygon(pts); // pts can be array of points {x,y} or flat array
    g.endFill();
};

window.drawPixiLine = (g, pA, pB, color, width) => {
    g.lineStyle(width, color);
    g.moveTo(pA.x, pA.y);
    g.lineTo(pB.x, pB.y);
    g.lineStyle(0); // Reset
};

// Returns a PIXI.Graphics object containing the greenhouse
// Helper: Convex Hull for Shadows (Monotone Chain) - GLOBAL
window.getConvexHull = (points) => {
    points.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (let p of points) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = points.length - 1; i >= 0; i--) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[i]) <= 0) upper.pop();
        upper.push(points[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
};

function createGreenhouse(x, y, partnerX, partnerY, showShadows, mode, splitMode, tileWidth, tileHeight, gridPath, getShadowShift, shadowColor, shadowNoStroke, isoToWorld, hexToRgba, scoreColor, showOutlines = false) {
    const g = new PIXI.Graphics();

    // Coordinates in World Space (viewport handles zoom/pan)
    const p1 = isoToWorld(x, y);
    const p2 = isoToWorld(partnerX, partnerY);
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2 + (tileHeight / 2);

    const dx = partnerX - x;
    const v_u = { x: tileWidth / 2, y: tileHeight / 2 };
    const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };

    let axisMain, axisPerp;
    if (Math.abs(dx) > 0) { // Merged along X
        axisMain = v_u;
        axisPerp = v_v;
    } else { // Merged along Y
        axisMain = v_v;
        axisPerp = v_u;
    }

    const L = 0.4; // Half-Length
    const W = 0.2; // Half-Width
    const Z = tileHeight * 0.4;
    const Z_peak = tileHeight * 0.6;

    // Corners (c1, c2 are Front/Partner side; c3, c4 are Back/My side)
    const c1 = { x: cx + axisMain.x * L + axisPerp.x * W, y: cy + axisMain.y * L + axisPerp.y * W };
    const c2 = { x: cx + axisMain.x * L - axisPerp.x * W, y: cy + axisMain.y * L - axisPerp.y * W };
    const c3 = { x: cx - axisMain.x * L - axisPerp.x * W, y: cy - axisMain.y * L - axisPerp.y * W };
    const c4 = { x: cx - axisMain.x * L + axisPerp.x * W, y: cy - axisMain.y * L + axisPerp.y * W };

    // Top Eaves
    const t1 = { x: c1.x, y: c1.y - Z };
    const t2 = { x: c2.x, y: c2.y - Z };
    const t3 = { x: c3.x, y: c3.y - Z };
    const t4 = { x: c4.x, y: c4.y - Z };

    // Ridge Ends
    const m12 = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 - (Z_peak - Z) };
    const m34 = { x: (t3.x + t4.x) / 2, y: (t3.y + t4.y) / 2 - (Z_peak - Z) };

    // Midpoints for Splitting (on the Seam)
    // Seam is at Local MainCoord = 0
    // c4->c1 line: mid point mc41
    const mc41 = { x: (c4.x + c1.x) / 2, y: (c4.y + c1.y) / 2 };
    const mc32 = { x: (c3.x + c2.x) / 2, y: (c3.y + c2.y) / 2 };

    // Eave Mids
    const mt41 = { x: (t4.x + t1.x) / 2, y: (t4.y + t1.y) / 2 };
    const mt32 = { x: (t3.x + t2.x) / 2, y: (t3.y + t2.y) / 2 };

    // Ridge Mid
    const mRidge = { x: (m34.x + m12.x) / 2, y: (m34.y + m12.y) / 2 };

    if (mode === 'SHADOW' && showShadows) {
        if (splitMode === 'FRONT') return g;

        g.beginFill(0x000000, 0.15);
        // g.lineStyle(0);

        const sEave = getShadowShift(Z);
        const sRidge = getShadowShift(Z_peak);
        // Use BASE corners (c1-c4) + shift for ground-level shadow projection
        const pT1 = { x: c1.x + sEave.x, y: c1.y + sEave.y };
        const pT2 = { x: c2.x + sEave.x, y: c2.y + sEave.y };
        const pT3 = { x: c3.x + sEave.x, y: c3.y + sEave.y };
        const pT4 = { x: c4.x + sEave.x, y: c4.y + sEave.y };
        const pM12 = { x: m12.x + sRidge.x, y: m12.y + Z_peak + sRidge.y };
        const pM34 = { x: m34.x + sRidge.x, y: m34.y + Z_peak + sRidge.y };

        g.drawPolygon([pT1, pM12, pT2, pT3, pM34, pT4]);
        g.endFill();
        return g;

    } else if (mode === 'BUILDING') {
        const frameColor = 0xFFFFFF; // White
        const outlineColor = 0xFFFFFF; // White thick outline

        // Blue glass tint for greenhouse
        const currentFaceColor = 0x87CEEB; // Sky Blue glass tint
        const glassAlpha = 0.5;
        const scaleFactor = tileHeight / 30;

        const drawFace = (pts) => {
            g.beginFill(currentFaceColor, glassAlpha);
            g.drawPolygon(pts);
            g.endFill();
        };
        const drawFrame = (pA, pB) => drawPixiLine(g, pA, pB, frameColor, 0.6 * scaleFactor);
        const drawThick = (pA, pB) => drawPixiLine(g, pA, pB, outlineColor, 1.0 * scaleFactor);
        const drawRidge = (pA, pB) => drawPixiLine(g, pA, pB, 0xFFFFFF, 1.0 * scaleFactor);

        const drawBackHalf = () => {
            drawFace([c4, mc41, mt41, t4]);
            drawFrame(c4, t4); drawFrame(t4, mt41); drawFrame(c4, mc41);

            drawFace([c3, mc32, mt32, t3]);
            drawFrame(c3, t3); drawFrame(t3, mt32); drawFrame(c3, mc32);

            drawFace([c4, c3, t3, t4]);
            drawFrame(c4, c3); drawFrame(c3, t3); drawFrame(t3, t4); drawFrame(t4, c4);

            drawFace([t4, mt41, mRidge, m34]);
            drawFrame(t4, mt41); drawFrame(t4, m34);

            drawFace([t3, m34, mRidge, mt32]);
            drawFrame(t3, mt32); drawFrame(t3, m34);

            drawRidge(m34, mRidge);
        };

        const drawFrontHalf = () => {
            drawFace([mc41, c1, t1, mt41]);
            drawFrame(c1, t1); drawFrame(t1, mt41); drawFrame(c1, mc41);

            drawFace([mc32, mt32, t2, c2]);
            drawFrame(c2, t2); drawFrame(t2, mt32); drawFrame(c2, mc32);

            drawFace([c2, c1, t1, t2]);
            drawFrame(c2, c1); drawFrame(c1, t1); drawFrame(t1, t2); drawFrame(t2, c2);

            drawFace([mt41, t1, m12, mRidge]);
            drawFrame(t1, mt41); drawFrame(t1, m12);

            drawFace([mt32, mRidge, m12, t2]);
            drawFrame(t2, mt32); drawFrame(t2, m12);

            drawRidge(mRidge, m12);
        };

        const drawOutlines = () => {
            if (!showOutlines) return;
            // Silhouette Logic:
            if (splitMode === 'BACK' || splitMode === 'ALL') {
                // Back Silhouette
                drawThick(c4, t4); // Left Wall Back Vertical
                drawThick(t4, m34); // Back Gable Left
                drawThick(m34, t3); // Back Gable Right
                drawThick(t3, c3); // Right Wall Back Vertical
                drawThick(c3, c4); // Ground Back
            }
            if (splitMode === 'FRONT' || splitMode === 'ALL') {
                // Front Silhouette
                drawThick(c4, c1); // Left Wall Ground
                drawThick(c1, c2); // Right Wall Ground
                drawThick(c2, c3); // Right Wall Ground Back 

                drawThick(c1, t1); // Front Vertical 
                drawThick(c2, t2); // Right Vertical

                // Eaves
                drawThick(t4, t1); // Left Eave
                drawThick(t3, t2); // Right Eave

                // Front Gable
                drawThick(t1, m12);
                drawThick(m12, t2);
            }
        };

        if (splitMode === 'ALL') {
            drawBackHalf();
            drawFrontHalf();
            drawOutlines();
        } else if (splitMode === 'BACK') {
            drawBackHalf();
            drawOutlines();
        } else if (splitMode === 'FRONT') {
            drawFrontHalf();
            drawOutlines();
        }
    }
    return g;
}

// Returns a PIXI.Graphics object containing the workshop
function createWorkshop(x, y, partnerX, partnerY, showShadows, mode, splitMode, tileWidth, tileHeight, gridPath, getShadowShift, shadowColor, shadowNoStroke, isoToWorld, lightenColor, darkenColor, baseColorStr, dataGrid, numCols, numRows, showOutlines, isGreenZoneCompliance = false, variant = 'MERGED', rotation = 0, drawTreeCallback = null) {
    const g = new PIXI.Graphics();

    // Helper: Convex Hull for Shadows (Monotone Chain) - hoisted for use by all variants
    const getConvexHull = window.getConvexHull;

    // --- COLOR LOGIC ---
    let baseColor = baseColorStr || '#FFCB77';
    let roofColor = lightenColor(baseColor, 30);
    if (isGreenZoneCompliance) {
        roofColor = '#748B6F'; // Sage Green for Green Zone Compliance
    } else if (variant === 'MERGED') {
        // Workshop Merged Color Tweaks
        // No specific change requested, but ensuring shadow consistency below.
    }

    // --- MERGED LOGIC (Legacy / Default) ---
    if (variant === 'MERGED') {
        // Coordinates in World Space
        const p1 = isoToWorld(x, y);
        const p2 = isoToWorld(partnerX, partnerY);
        const cx = (p1.x + p2.x) / 2;
        const cy = (p1.y + p2.y) / 2 + (tileHeight / 2);

        const dx = partnerX - x;
        const v_u = { x: tileWidth / 2, y: tileHeight / 2 };
        const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };

        let axisMain, axisPerp;
        if (Math.abs(dx) > 0) {
            axisMain = v_u; axisPerp = v_v;
        } else {
            axisMain = v_v; axisPerp = v_u;
        }

        const L = 0.5;
        const W = 0.35;
        const Z_low = tileHeight * 0.4;
        const Z_high = tileHeight * 0.7;

        // Corners (c1, c2 are Front; c3, c4 are Back)
        const c1 = { x: cx + axisMain.x * L + axisPerp.x * W, y: cy + axisMain.y * L + axisPerp.y * W };
        const c2 = { x: cx + axisMain.x * L - axisPerp.x * W, y: cy + axisMain.y * L - axisPerp.y * W };
        const c3 = { x: cx - axisMain.x * L - axisPerp.x * W, y: cy - axisMain.y * L - axisPerp.y * W };
        const c4 = { x: cx - axisMain.x * L + axisPerp.x * W, y: cy - axisMain.y * L + axisPerp.y * W };

        // Roof Corners
        const t1 = { x: c1.x, y: c1.y - Z_high };
        const t2 = { x: c2.x, y: c2.y - Z_low };
        const t3 = { x: c3.x, y: c3.y - Z_low };
        const t4 = { x: c4.x, y: c4.y - Z_high };

        // Midpoints
        const mc41 = { x: (c4.x + c1.x) / 2, y: (c4.y + c1.y) / 2 };
        const mc32 = { x: (c3.x + c2.x) / 2, y: (c3.y + c2.y) / 2 };
        const mt41 = { x: (t4.x + t1.x) / 2, y: (t4.y + t1.y) / 2 };
        const mt32 = { x: (t3.x + t2.x) / 2, y: (t3.y + t2.y) / 2 };

        let baseColor = baseColorStr || '#FFCB77';
        let roofColor = lightenColor(baseColor, 30);

        if (mode === 'SHADOW' && showShadows) {
            if (splitMode === 'FRONT') return g;

            g.beginFill(0x000000, 0.15);

            const sHigh = getShadowShift(Z_high);
            const sLow = getShadowShift(Z_low);

            // Project Roof Corners to Ground
            const pT1 = { x: t1.x + sHigh.x, y: t1.y + Z_high + sHigh.y };
            const pT4 = { x: t4.x + sHigh.x, y: t4.y + Z_high + sHigh.y };
            const pT2 = { x: t2.x + sLow.x, y: t2.y + Z_low + sLow.y };
            const pT3 = { x: t3.x + sLow.x, y: t3.y + Z_low + sLow.y };

            // Workshop Shadow Hull
            // Merge footprint (c1..c4) with projected roof points
            // Note: c1..c4 are at Z=0.
            const shadowPts = [c1, c2, c3, c4, pT1, pT2, pT3, pT4];
            const hull = getConvexHull(shadowPts);

            g.drawPolygon(hull);
            g.endFill();

        } else if (mode === 'BUILDING') {
            const drawFace = (pts, color) => drawPixiPolygon(g, pts, color);

            let shadingF2, shadingF3;
            if (Math.abs(dx) > 0) { // Horizontal
                shadingF3 = 15; shadingF2 = 25;
            } else { // Vertical
                shadingF2 = 15; shadingF3 = 25;
            }

            const drawBackHalf = () => {
                drawFace([mc32, c3, t3, mt32], darkenColor(baseColor, shadingF2));
                drawFace([c3, c4, t4, t3], darkenColor(baseColor, 25));
                drawFace([c4, mc41, mt41, t4], darkenColor(baseColor, shadingF3));
                drawFace([t4, mt41, mt32, t3], roofColor);
            };

            const drawFrontHalf = () => {
                drawFace([c2, mc32, mt32, t2], darkenColor(baseColor, shadingF2));
                drawFace([c1, c2, t2, t1], darkenColor(baseColor, shadingF2));
                drawFace([mc41, c1, t1, mt41], darkenColor(baseColor, shadingF3));
                drawFace([mt41, t1, t2, mt32], roofColor);
            };

            const drawOutlines = () => {
                if (showOutlines) {
                    const strokeColor = 0x000000;
                    const strokeAlpha = 0.8;
                    const scaleFactor = tileHeight / 30;
                    const thinWidth = 0.4 * scaleFactor;
                    const thickWidth = 1.0 * scaleFactor;

                    const dL = (pA, pB, thick) => {
                        g.lineStyle(thick ? thickWidth : thinWidth, strokeColor, strokeAlpha);
                        g.moveTo(pA.x, pA.y);
                        g.lineTo(pB.x, pB.y);
                        g.lineStyle(0);
                    };

                    if (splitMode === 'BACK' || splitMode === 'ALL') {
                        dL(t3, t4, true); dL(t4, c4, true); dL(t4, mt41, true); dL(t3, mt32, true);
                    }
                    if (splitMode === 'FRONT' || splitMode === 'ALL') {
                        dL(t1, t2, true); dL(t1, c1, true); dL(t2, c2, true); dL(c1, c2, true);
                        dL(mt41, t1, true); dL(mt32, t2, true);
                    }
                }
            };

            if (splitMode === 'ALL') { drawBackHalf(); drawFrontHalf(); drawOutlines(); }
            else if (splitMode === 'BACK') { drawBackHalf(); drawOutlines(); }
            else if (splitMode === 'FRONT') { drawFrontHalf(); drawOutlines(); }
        }
        if (isGreenZoneCompliance && drawTreeCallback && mode === 'BUILDING' && (splitMode === 'ALL' || splitMode === 'FRONT')) {
            // Logic for Merged Workshop Tree
            // Master is (x,y).
            const pMaster = isoToWorld(x, y);
            const treeX = pMaster.x;
            const treeY = pMaster.y + tileHeight * 0.5;

            // Offset for "Safe Spot" (Top Corner)
            const v_u = { x: tileWidth / 2, y: tileHeight / 2 };
            const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };
            const uOff = -0.35, vOff = -0.35;
            const gw = 1 / 3; // 1x1 on 3x3 grid (1/9th area)
            const gu0 = -0.5, gv0 = -0.5;

            const getP = (u, v) => ({
                x: treeX + u * v_u.x + v * v_v.x,
                y: treeY + u * v_u.y + v * v_v.y
            });

            const pG1 = getP(gu0, gv0);
            const pG2 = getP(gu0 + gw, gv0);
            const pG3 = getP(gu0 + gw, gv0 + gw);
            const pG4 = getP(gu0, gv0 + gw);

            g.beginFill(0x7FCD91); // Grass Green
            g.drawPolygon([pG1, pG2, pG3, pG4]);
            g.endFill();

            // 2. Draw Tree
            const tc = getP(gu0 + gw / 2, gv0 + gw / 2);
            // Assuming drawTreeCallback is now createTree(g, ...)
            drawTreeCallback(g, tc.x, tc.y, false, getShadowShift, 'rgba(0,0,0,0.2)', null, 0.7);
        }
        return g; // END MERGED
    }

    // --- NEW SKINS LOGIC (Single) ---
    // Note: splitMode is usually 'ALL' for single plots (passed in script.js)

    const p0 = isoToWorld(x, y);
    const cx = p0.x;
    const cy = p0.y + tileHeight / 2;

    // Sub-grid basis
    const uStep = 1 / 3;
    const v_u = { x: tileWidth / 2, y: tileHeight / 2 };
    const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };

    // Helper: Get Screen Pos for Sub-Coordinate (0..3 range on layout) relative to Center (1.5, 1.5)
    // Actually, let's use normalized 0..1 range for easier math? 
    // Layout 3x3 means cells 0,1,2.
    // Center is (1.5, 1.5) in cell steps? No, center is center.
    // Let's use Offset from Center (0,0).
    const getPos = (uOff, vOff, z = 0) => {
        // uOff, vOff in range -0.5 to 0.5 (Full Tile)
        // Rotation (0, 1, 2, 3) 90 deg clockwise
        let ru = uOff, rv = vOff;
        for (let i = 0; i < rotation; i++) {
            const t = ru; ru = -rv; rv = t;
        }
        return {
            x: cx + ru * v_u.x + rv * v_v.x, // FIXED: Removed * 2
            y: cy + ru * v_u.y + rv * v_v.y - z
        };
    };

    // Helper: Create Render Cuboid
    const createCuboid = (uMin, vMin, uWidth, vWidth, zBase, zHeight, color, roofType = 'FLAT', roofShade = null, skipShadow = false) => {
        // Center for Depth Sorting based on FOOTPRINT (Z=0)
        const sortY = getPos(uMin + uWidth / 2, vMin + vWidth / 2, 0).y;

        return {
            type: 'cuboid',
            sortY: sortY,
            zBase: zBase,
            draw: () => {
                // Geometry Points (Base)
                const pts = [
                    { u: uMin, v: vMin },
                    { u: uMin + uWidth, v: vMin },
                    { u: uMin + uWidth, v: vMin + vWidth },
                    { u: uMin, v: vMin + vWidth }
                ].map(p => getPos(p.u, p.v, zBase));

                // Geometry Tops (Flat Box reference for Shadows)
                const flatTops = [
                    { u: uMin, v: vMin },
                    { u: uMin + uWidth, v: vMin },
                    { u: uMin + uWidth, v: vMin + vWidth },
                    { u: uMin, v: vMin + vWidth }
                ].map(p => getPos(p.u, p.v, zBase + zHeight));

                // Visual Tops (Clone flatTops to modify for Rendering)
                const tops = flatTops.map(p => ({ ...p }));

                // GABLE Logic
                let ridgePts = [];
                if (roofType === 'GABLE') {
                    const rise = Math.min(uWidth, vWidth) * 0.5 * tileHeight;
                    const zRidge = zBase + zHeight + rise;
                    const rp1 = getPos(uMin + uWidth / 2, vMin, zRidge);
                    const rp2 = getPos(uMin + uWidth / 2, vMin + vWidth, zRidge);
                    ridgePts = [rp1, rp2];
                }

                // Tilted Roof Adjustments (Modify Visual Tops only)
                if (roofType === 'TILT_X') {
                    tops[0].y += zHeight * 0.3; tops[3].y += zHeight * 0.3;
                } else if (roofType === 'SLANT') {
                    tops[1].y += zHeight * 0.3; tops[2].y += zHeight * 0.3;
                }

                // Shadow Logic
                const shouldDrawShadow = !skipShadow && showShadows && (mode === 'SHADOW' || (mode === 'BUILDING' && splitMode === 'ALL'));

                if (shouldDrawShadow) {
                    const project = (p, z) => {
                        const s = getShadowShift(z);
                        // p.y already has -z baked in from getPos(); add z back to reach ground
                        return { x: p.x + s.x, y: p.y + z + s.y };
                    };
                    const allShadowPts = [];
                    pts.forEach(p => allShadowPts.push(project(p, zBase)));

                    if (roofType === 'GABLE') {
                        const rise = Math.min(uWidth, vWidth) * 0.5 * tileHeight;
                        const zRidge = zBase + zHeight + rise;
                        [flatTops[0], flatTops[1], flatTops[2], flatTops[3]].forEach(p => allShadowPts.push(project(p, zBase + zHeight)));
                        ridgePts.forEach(p => allShadowPts.push(project(p, zRidge)));
                    } else {
                        const zTopRef = zBase + zHeight;
                        flatTops.forEach(p => allShadowPts.push(project(p, zTopRef)));
                    }

                    const hull = getConvexHull(allShadowPts);
                    g.beginFill(0x000000, 0.15);
                    g.drawPolygon(hull);
                    g.endFill();
                }

                // Building Draw
                if (mode === 'BUILDING') {
                    // Collect all outline points for Silhouette
                    const allOutlinePts = [...pts, ...tops, ...ridgePts];

                    // Face Sorting
                    const wallFaces = [
                        { ptr: [pts[0], pts[1], tops[1], tops[0]], col: 0 },
                        { ptr: [pts[3], pts[0], tops[0], tops[3]], col: 3 },
                        { ptr: [pts[1], pts[2], tops[2], tops[1]], col: 1 },
                        { ptr: [pts[2], pts[3], tops[3], tops[2]], col: 2 }
                    ];
                    wallFaces.forEach(f => {
                        f.avgY = (f.ptr[0].y + f.ptr[1].y + f.ptr[2].y + f.ptr[3].y) / 4;
                    });
                    wallFaces.sort((a, b) => a.avgY - b.avgY);

                    const shadeMap = [darkenColor(color, 35), darkenColor(color, 25), darkenColor(color, 15), darkenColor(color, 25)];
                    const scaleFactor = tileHeight / 30;
                    const thickWidth = 1.2 * scaleFactor; // Outer Hull

                    // Draw Walls
                    wallFaces.forEach(f => {
                        const shadeIndex = (f.col + rotation) % 4;
                        g.beginFill(shadeMap[shadeIndex]);
                        g.drawPolygon(f.ptr);
                        g.endFill();
                    });

                    // Draw Roof
                    if (roofType === 'GABLE') {
                        const frontTri = [tops[0], tops[1], ridgePts[0]];
                        const backTri = [tops[3], tops[2], ridgePts[1]];
                        const leftSlope = [tops[0], tops[3], ridgePts[1], ridgePts[0]];
                        const rightSlope = [tops[1], tops[2], ridgePts[1], ridgePts[0]];

                        const frontShadeIndex = (0 + rotation) % 4;
                        const backShadeIndex = (2 + rotation) % 4;

                        const faces = [
                            { cur: frontTri, col: shadeMap[frontShadeIndex] },
                            { cur: backTri, col: shadeMap[backShadeIndex] },
                            { cur: leftSlope, col: roofShade || lightenColor(color, 20) }, // Slopes use roofShade or lightenColor
                            { cur: rightSlope, col: roofShade ? darkenColor(roofShade, 10) : color }
                        ];

                        faces.forEach(f => {
                            let sumY = 0; f.cur.forEach(p => sumY += p.y); f.avgY = sumY / f.cur.length;
                        });
                        faces.sort((a, b) => a.avgY - b.avgY);

                        faces.forEach(f => {
                            g.beginFill(f.col);
                            g.drawPolygon(f.cur);
                            g.endFill();
                        });

                    } else {
                        // Standard Roof
                        g.beginFill(roofShade || lightenColor(color, 20));
                        g.drawPolygon(tops);
                        g.endFill();
                    }

                    // OUTER HULL (Bold Outline)
                    if (showOutlines && roofType !== 'NO_OUTLINE') {
                        const hull = getConvexHull(allOutlinePts);
                        g.lineStyle(thickWidth, 0x000000, 0.8);
                        g.drawPolygon(hull);
                        g.lineStyle(0);
                    }
                }
            }
        };
    };

    const mainColor = baseColorStr || '#FFCB77';
    const components = [];

    // SKINS
    if (variant === 0) {
        // --- GARAGE ---
        // --- GARAGE ---
        const w = 0.30;
        let l = 0.60;
        let carOffset = 0;

        // PATH CHECK: If facing a path, shrink building and move car back
        // Rotation Mappings: 0=Bottom (Y+), 1=Left (X-), 2=Top (Y-), 3=Right (X+)
        const plot = dataGrid[y][x]; // Ensure plot is available
        let frontIsPath = false;
        if (rotation === 0) { // Facing Bottom (Y+1)
            if (plot.paths && plot.paths.bottom) frontIsPath = true;
        } else if (rotation === 3) { // Facing Right (X+1)
            if (plot.paths && plot.paths.right) frontIsPath = true;
        } else if (rotation === 1) { // Facing Left (X-1)
            if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) frontIsPath = true;
        } else if (rotation === 2) { // Facing Top (Y-1)
            if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) frontIsPath = true;
        }

        if (frontIsPath) {
            l = 0.50; // Shrink building to make room
            carOffset = -0.10; // Pull car back towards building center
        }

        // Building (Gable Roof) - Use computed roofColor if compliant, otherwise GABLE logic handles it (or we pass it)
        // If Green Zone: Pass roofColor as the roof color override (last arg or special handling)
        // createCuboid(x, y, w, l, z, h, color, roofType, roofShade, noOutline)
        // We need to pass roofColor as roofShade if compliant.
        components.push(createCuboid(-w / 2, -0.45, w, l, 0, tileHeight * 0.35, mainColor, 'GABLE', isGreenZoneCompliance ? roofColor : null));

        // Car (Skip individual shadows, draw combined below)
        const cColor = '#D7CCC8';
        const cTop = '#EFEBE9';
        const wheelH = tileHeight * 0.05;
        // Apply carOffset to cY
        const cX = -0.09;
        const cY = 0.15 + carOffset;
        const cW = 0.18; const cL = 0.32;
        // Wheels
        components.push(createCuboid(cX - 0.02, cY + 0.05, 0.02, 0.06, 0, wheelH, '#5D4037', 'NO_OUTLINE', null, true));
        components.push(createCuboid(cX + cW, cY + 0.05, 0.02, 0.06, 0, wheelH, '#5D4037', 'NO_OUTLINE', null, true));
        components.push(createCuboid(cX - 0.02, cY + cL - 0.1, 0.02, 0.06, 0, wheelH, '#5D4037', 'NO_OUTLINE', null, true));
        components.push(createCuboid(cX + cW, cY + cL - 0.1, 0.02, 0.06, 0, wheelH, '#5D4037', 'NO_OUTLINE', null, true));
        // Chassis (NO OUTLINE)
        components.push(createCuboid(cX, cY, cW, cL, tileHeight * 0.02, tileHeight * 0.08, cColor, 'NO_OUTLINE', null, true));
        // Cabin (NO OUTLINE)
        components.push(createCuboid(cX + 0.01, cY + 0.08, cW - 0.02, cL - 0.14, tileHeight * 0.10, tileHeight * 0.07, darkenColor(cColor, 10), 'NO_OUTLINE', cTop, true));

        // Draw single combined shadow for entire car
        if (showShadows && (mode === 'SHADOW' || (mode === 'BUILDING' && splitMode === 'ALL'))) {
            const cabinHeight = tileHeight * 0.10 + tileHeight * 0.07;

            // Get all car footprint corners (wheels at the extremes)
            const carFootprint = [
                getPos(cX - 0.02, cY + 0.05, 0),
                getPos(cX + cW + 0.02, cY + 0.05, 0),
                getPos(cX + cW + 0.02, cY + cL - 0.04, 0),
                getPos(cX - 0.02, cY + cL - 0.04, 0)
            ];

            // Get cabin top corners (highest point of car)
            const cabinTop = [
                getPos(cX + 0.01, cY + 0.08, cabinHeight),
                getPos(cX + cW - 0.01, cY + 0.08, cabinHeight),
                getPos(cX + cW - 0.01, cY + cL - 0.06, cabinHeight),
                getPos(cX + 0.01, cY + cL - 0.06, cabinHeight)
            ];

            // Project all points to create shadow
            const allShadowPts = [];
            const project = (p, z) => {
                const s = getShadowShift(z);
                // p.y already has -z baked in from getPos(); add z back to reach ground
                return { x: p.x + s.x, y: p.y + z + s.y };
            };

            carFootprint.forEach(p => allShadowPts.push(project(p, 0)));
            cabinTop.forEach(p => allShadowPts.push(project(p, cabinHeight)));

            // Draw combined shadow hull
            const hull = getConvexHull(allShadowPts);
            g.beginFill(0x000000, 0.15);
            g.drawPolygon(hull);
            g.endFill();
        }

    } else if (variant === 1) {
        // --- SOCIAL ---
        const s = 0.60;
        components.push(createCuboid(-0.45, -0.45, s, s, 0, tileHeight * 0.4, mainColor, 'FLAT', isGreenZoneCompliance ? roofColor : '#CCCCCC'));

    } else if (variant === 2) {
        // --- ACTUAL ---
        const s = 0.30;
        components.push(createCuboid(-s / 2, -0.45, s, s, 0, tileHeight * 0.35, mainColor, 'SLANT', isGreenZoneCompliance ? roofColor : null));

        if (mode === 'BUILDING') {
            const pZ = tileHeight * 0.20;
            const cLen = 0.30;
            const cStart = -0.45 + s;

            // Slab (NO OUTLINE for cleaner look)
            components.push(createCuboid(-s / 2, cStart, s, cLen, pZ, tileHeight * 0.03, mainColor, 'NO_OUTLINE', mainColor));

            const poleW = 0.015;
            components.push(createCuboid(s / 2 - poleW, cStart + cLen - poleW, poleW, poleW, 0, pZ, mainColor, 'NO_OUTLINE'));
            components.push(createCuboid(-s / 2, cStart + cLen - poleW, poleW, poleW, 0, pZ, mainColor, 'NO_OUTLINE'));

            // Stacked Lumber (Skip individual shadows, draw combined below)
            const bW = 0.25; const bL = 0.1; const bX = -0.125; const bY = 0.15; const bH = 0.02;
            components.push(createCuboid(bX, bY, bW, bL, 0, tileHeight * bH, '#8D6E63', 'NO_OUTLINE', null, true));
            components.push(createCuboid(bX, bY, bW, bL, tileHeight * bH, tileHeight * bH, '#8D6E63', 'NO_OUTLINE', null, true));
            components.push(createCuboid(bX, bY, bW, bL, tileHeight * (bH * 2), tileHeight * bH, '#8D6E63', 'NO_OUTLINE', null, true));

            // Draw single combined shadow for all lumber planks
            if (showShadows && (mode === 'SHADOW' || (mode === 'BUILDING' && splitMode === 'ALL'))) {
                const totalHeight = tileHeight * (bH * 3);

                // Get the 4 corners of the lumber stack footprint
                const lumberCorners = [
                    getPos(bX, bY, 0),
                    getPos(bX + bW, bY, 0),
                    getPos(bX + bW, bY + bL, 0),
                    getPos(bX, bY + bL, 0)
                ];

                // Get the 4 corners at the top of the stack
                const lumberTop = [
                    getPos(bX, bY, totalHeight),
                    getPos(bX + bW, bY, totalHeight),
                    getPos(bX + bW, bY + bL, totalHeight),
                    getPos(bX, bY + bL, totalHeight)
                ];

                // Project all points to create shadow
                const allShadowPts = [];
                const project = (p, z) => {
                    const s = getShadowShift(z);
                    // p.y already has -z baked in from getPos(); add z back to reach ground
                    return { x: p.x + s.x, y: p.y + z + s.y };
                };

                lumberCorners.forEach(p => allShadowPts.push(project(p, 0)));
                lumberTop.forEach(p => allShadowPts.push(project(p, totalHeight)));

                // Draw combined shadow hull
                const hull = getConvexHull(allShadowPts);
                g.beginFill(0x000000, 0.15);
                g.drawPolygon(hull);
                g.endFill();
            }
        }
    }

    // SINGLE WORKSHOP: Green Zone Compliance Tree (Added to Components for Sorting)
    if (isGreenZoneCompliance && drawTreeCallback && variant !== 'MERGED' && mode === 'BUILDING' && (splitMode === 'ALL' || splitMode === 'FRONT')) {
        // SMART PLACEMENT LOGIC
        // Grid: 3x3. Indices:
        // 0 1 2 (Top Row)
        // 3 4 5 (Mid Row)
        // 6 7 8 (Bot Row)

        const cell = 1 / 3;
        const cPos = cell;
        // Map Index to (u, v) centered coords
        const idxToUV = (i) => {
            const r = Math.floor(i / 3);
            const c = i % 3;
            // r=0 -> v=-cPos, r=1 -> v=0, r=2 -> v=cPos
            // c=0 -> u=-cPos, c=1 -> u=0, c=2 -> u=cPos
            return { u: (c - 1) * cell, v: (r - 1) * cell };
        };

        const blocked = new Set();

        // 1. Block Paths
        const plot = dataGrid[y][x];
        if (plot.paths) {
            if (plot.paths.right) [2, 5, 8].forEach(i => blocked.add(i));
            if (plot.paths.bottom) [6, 7, 8].forEach(i => blocked.add(i));
        }
        // Check neighbors for Left/Top paths (if dataGrid available)
        // Left Path exists if Left Neighbor has Right Path
        if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) [0, 3, 6].forEach(i => blocked.add(i));
        // Top Path exists if Top Neighbor has Bottom Path
        if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) [0, 1, 2].forEach(i => blocked.add(i));

        // 2. Block Building/Pavement per Variant (Rough approximations in rotated space?)
        // Note: The logic below calculates uTree/vTree in UNROTATED local space, 
        // createCuboid/ getPos handles rotation. 
        // SO we should define blocked spots in UNROTATED space.

        if (variant === 0) { // Garage
            // Building: Large, Centered-ish. 
            // Pavement: Bottom (7).
            // Block: 4 (Center), 7 (Bot), 1 (Top-Center - usually roof overhang), 
            // 3, 5 (Sides - potentially tight). 
            // Open: Corners (0, 2, 6, 8)?
            [1, 3, 4, 5, 7].forEach(i => blocked.add(i));
        } else if (variant === 1) { // Social
            // Offset (-0.45). It's Top-Left ish?
            // createCuboid(-0.45, -0.45...) -> Top Left
            // Block: 0, 1, 3, 4. 
            // Pavement: Right Side (2, 5, 8)? Or just 5?
            // Let's block Top-Left Quadrant.
            [0, 1, 3, 4].forEach(i => blocked.add(i));
        } else if (variant === 2) { // Actual
            // Stacks.
            // Block Center and surrounding?
            // Let's just try to find ANY free corner.
            [4].forEach(i => blocked.add(i));
        }

        // 3. Find Free Spot
        // Preference Order: Corners first, then Mids.
        const candidates = [0, 2, 6, 8, 1, 3, 5, 7];
        let chosenIdx = -1;

        // Fix for Social (Var 1): Explicitly prefers Bottom-Right (8) or Bottom (7) or Right (5)
        if (variant === 1) {
            // Social occupies TL. BR(8) is best.
            const pref = [8, 7, 5, 6, 2];
            for (let i of pref) { if (!blocked.has(i)) { chosenIdx = i; break; } }
        } else {
            for (let i of candidates) { if (!blocked.has(i)) { chosenIdx = i; break; } }
        }

        // Fallback if all blocked (shouldn't happen often): Use 0 (TL) or 8 (BR)
        if (chosenIdx === -1) chosenIdx = 8;

        const coords = idxToUV(chosenIdx);
        let uTree = coords.u;
        let vTree = coords.v;

        const pos = getPos(uTree, vTree, 0); // Ground level

        components.push({
            type: 'tree',
            sortY: pos.y, // Sort based on screen Y
            zBase: 0,
            draw: () => {
                // 1. Draw Green Square (Standard 1/3 Size)
                const gw = 1 / 3;
                const u0 = uTree - gw / 2;
                const v0 = vTree - gw / 2;
                const p1 = getPos(u0, v0, 0);
                const p2 = getPos(u0 + gw, v0, 0);
                const p3 = getPos(u0 + gw, v0 + gw, 0);
                const p4 = getPos(u0, v0 + gw, 0);

                g.beginFill(0x7FCD91); // Grass Green
                g.drawPolygon([p1, p2, p3, p4]);
                g.endFill();

                // 2. Draw Tree
                // Assuming drawTreeCallback is now createTree(g, ...)
                if (drawTreeCallback) {
                    drawTreeCallback(g, pos.x, pos.y, showShadows, getShadowShift, 'rgba(0,0,0,0.2)', gridPath, 0.7);
                }
            }
        });
    }

    // EXECUTE SORTED DRAWS
    // Sort logic: 1. By Y (Footprint Back-to-Front). 2. By Z (Low to High) for overlap.
    components.sort((a, b) => {
        const diff = a.sortY - b.sortY;
        if (Math.abs(diff) < 1.0) { // Screen epsilon
            return a.zBase - b.zBase;
        }
        return diff;
    });
    components.forEach(c => c.draw());
    return g;
}

// Helper for Drawing Sports Items (Soccer Goal / Basketball Hoop / Tennis Court)
// Helper for Drawing Sports Ground Markings (Pixi Adapter)
function addSportGround(g, screenX, screenY, tileWidth, tileHeight, variant, rotation, squish = { l: 0, r: 0, t: 0, b: 0 }) {
    let centerX = screenX;
    let centerY = screenY + tileHeight / 2;

    // Apply Squish (Centering and Scaling)
    const wFactor = 1 - squish.l - squish.r;
    const hFactor = 1 - squish.t - squish.b;
    const uniformScale = Math.min(wFactor, hFactor);

    const shiftU = (squish.l - squish.r) / 2;
    const shiftV = (squish.t - squish.b) / 2;

    const shiftX = (shiftU - shiftV) * tileWidth / 2;
    const shiftY = (shiftU + shiftV) * tileHeight / 2;

    centerX += shiftX;
    centerY += shiftY;

    // Apply Scale
    const effTileWidth = tileWidth * uniformScale;
    const effTileHeight = tileHeight * uniformScale;

    // Override local vars
    tileWidth = effTileWidth;
    tileHeight = effTileHeight;

    const scaleFactor = tileHeight / 30;

    const getRotatedOffset = (u, v) => {
        let ru = u, rv = v;
        for (let i = 0; i < rotation; i++) {
            const temp = ru; ru = -rv; rv = temp;
        }
        const sx = (ru - rv) * tileWidth / 2;
        const sy = (ru + rv) * tileHeight / 2;
        return { x: centerX + sx, y: centerY + sy };
    };

    if (variant === 1) {
        // --- BASKETBALL COURT (Half Court) Markings ---
        g.lineStyle(0.7 * scaleFactor, 0xFFFFFF, 0.5);

        const kBL = getRotatedOffset(-0.4, -0.15);
        const kBR = getRotatedOffset(0.1, -0.15);
        const kTR = getRotatedOffset(0.1, 0.15);
        const kTL = getRotatedOffset(-0.4, 0.15);

        // Box
        g.moveTo(kBL.x, kBL.y);
        g.lineTo(kBR.x, kBR.y);
        g.lineTo(kTR.x, kTR.y);
        g.lineTo(kTL.x, kTL.y);
        // g.closePath()? Or just lines? Original didn't close path explicitly but moved to start?
        // Original: moveTo(BL), lineTo(BR, TR, TL). Stroke. (Open U-shape?)
        // Let's assume U-shape or Box.
        // Actually original was: moveTo(BL), lineTo(BR), lineTo(TR), lineTo(TL). Stroke.
        // It draws 3 sides.

        // Arc
        // Pixi arc: g.arc(cx, cy, radius, startAngle, endAngle)
        // Original: calculated points manually loop.
        // We can replicate the loop with lineTo for safety/easier transform.
        const arcSteps = 10;
        let first = true;
        for (let i = 0; i <= arcSteps; i++) {
            const angle = -Math.PI / 2 + (Math.PI * i / arcSteps);
            const u = -0.4 + Math.cos(angle) * 0.7;
            const v = Math.sin(angle) * 0.4;
            const p = getRotatedOffset(u, v);
            if (first) { g.moveTo(p.x, p.y); first = false; }
            else g.lineTo(p.x, p.y);
        }
        g.lineStyle(0);

    } else if (variant === 3) {
        // --- TENNIS COURT (Merged Pair) Markings ---
        g.lineStyle(0.7 * scaleFactor, 0xFFFFFF, 0.6);

        // Outer Boundary
        const bTL = getRotatedOffset(-0.4, -0.4);
        const bBL = getRotatedOffset(-0.4, 0.4);
        const bTR = getRotatedOffset(0.5, -0.4);
        const bBR = getRotatedOffset(0.5, 0.4);

        g.moveTo(bTR.x, bTR.y);
        g.lineTo(bTL.x, bTL.y);
        g.lineTo(bBL.x, bBL.y);
        g.lineTo(bBR.x, bBR.y);

        // Inner Service Box
        const sTL = getRotatedOffset(-0.15, -0.25);
        const sBL = getRotatedOffset(-0.15, 0.25);
        const sTR = getRotatedOffset(0.5, -0.25);
        const sBR = getRotatedOffset(0.5, 0.25);

        g.moveTo(sTR.x, sTR.y); g.lineTo(sTL.x, sTL.y);
        g.lineTo(sBL.x, sBL.y); g.lineTo(sBR.x, sBR.y);

        // Center Serve Line
        const c1 = getRotatedOffset(-0.15, 0);
        const c2 = getRotatedOffset(0.5, 0);
        g.moveTo(c1.x, c1.y); g.lineTo(c2.x, c2.y);

        g.lineStyle(0);
    }
}

// Helper for Drawing Sports Items (Objects: Goals, Hoops, Nets) - Pass 2
// Renamed from drawSportItem -> drawSportObject -> addSportObject (Pixi)
function addSportObject(g, screenX, screenY, tileWidth, tileHeight, variant, rotation, showShadows, getShadowShift, shadowColor, gridPath, isMaster = false, squish = { l: 0, r: 0, t: 0, b: 0 }) {
    let centerX = screenX;
    let centerY = screenY + tileHeight / 2;

    // Apply Squish (Centering and Scaling)
    const wFactor = 1 - squish.l - squish.r;
    const hFactor = 1 - squish.t - squish.b;
    const uniformScale = Math.min(wFactor, hFactor);

    const shiftU = (squish.l - squish.r) / 2;
    const shiftV = (squish.t - squish.b) / 2;

    const shiftX = (shiftU - shiftV) * tileWidth / 2;
    const shiftY = (shiftU + shiftV) * tileHeight / 2;

    centerX += shiftX;
    centerY += shiftY;

    tileWidth = tileWidth * uniformScale;
    tileHeight = tileHeight * uniformScale;

    const scaleFactor = tileHeight / 30;

    const getRotatedOffset = (u, v) => {
        let ru = u, rv = v;
        for (let i = 0; i < rotation; i++) {
            const temp = ru; ru = -rv; rv = temp;
        }
        const sx = (ru - rv) * tileWidth / 2;
        const sy = (ru + rv) * tileHeight / 2;
        return { x: centerX + sx, y: centerY + sy };
    };

    // Helper to draw shadows (Removed clipping for Pixi performance)
    const drawShadowPoly = (pts) => {
        g.beginFill(0x000000, 0.15);
        g.drawPolygon(pts);
        g.endFill();
    };

    if (variant === 0) {
        // --- SOCCER GOAL ---
        const goalH = 10 * scaleFactor;
        const goalW_Local = 0.4;
        const vLeft = -goalW_Local / 2;
        const vRight = goalW_Local / 2;
        const pL = getRotatedOffset(-0.4, vLeft);
        const pR = getRotatedOffset(-0.4, vRight);

        if (showShadows) {
            const s = getShadowShift(goalH);
            // Line shadows for posts and crossbar (open structure)
            const shadowTipL = { x: pL.x + s.x, y: pL.y + s.y };
            const shadowTipR = { x: pR.x + s.x, y: pR.y + s.y };

            g.lineStyle(1.5 * scaleFactor, 0x000000, 0.15);
            // Post L shadow
            g.moveTo(pL.x, pL.y); g.lineTo(shadowTipL.x, shadowTipL.y);
            // Post R shadow
            g.moveTo(pR.x, pR.y); g.lineTo(shadowTipR.x, shadowTipR.y);
            // Crossbar shadow
            g.moveTo(shadowTipL.x, shadowTipL.y); g.lineTo(shadowTipR.x, shadowTipR.y);
            g.lineStyle(0);
        }

        // Object
        g.lineStyle(1.5 * scaleFactor, 0xFFFFFF);

        // Post L
        g.moveTo(pL.x, pL.y); g.lineTo(pL.x, pL.y - goalH);
        // Post R
        g.moveTo(pR.x, pR.y); g.lineTo(pR.x, pR.y - goalH);
        // Crossbar
        g.moveTo(pL.x, pL.y - goalH); g.lineTo(pR.x, pR.y - goalH);

        g.lineStyle(0);

        // Net
        g.beginFill(0xFFFFFF, 0.1);
        g.drawPolygon([
            { x: pL.x, y: pL.y - goalH },
            { x: pR.x, y: pR.y - goalH },
            { x: pR.x, y: pR.y },
            { x: pL.x, y: pL.y }
        ]);
        g.endFill();

    } else if (variant === 1) {
        // --- BASKETBALL HOOP ---
        const poleH = 14 * scaleFactor;
        const boardH = 4 * scaleFactor;
        const boardW = 6 * scaleFactor;
        const centerPos = getRotatedOffset(-0.4, 0);
        const boardCenterY = centerPos.y - poleH;

        if (showShadows) {
            g.lineStyle(1.5 * scaleFactor, 0x000000, 0.15);
            // Pixi doesn't have composite operations on Graphics easily?
            // Ignoring 'darken' composite for simplicity, or use alpha.

            const s = getShadowShift(poleH);
            const topPos = { x: centerPos.x, y: centerPos.y - poleH };
            // Add poleH back to project shadow to ground level
            const shadowTip = { x: topPos.x + s.x, y: topPos.y + poleH + s.y };

            const vVecP = getRotatedOffset(0, 0.1);
            const vVecN = getRotatedOffset(0, -0.1);
            const dx = vVecP.x - vVecN.x;
            const dy = vVecP.y - vVecN.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const udx = dx / len; const udy = dy / len;

            const bShadowL = { x: shadowTip.x - udx * boardW / 2, y: shadowTip.y - udy * boardW / 2 };
            const bShadowR = { x: shadowTip.x + udx * boardW / 2, y: shadowTip.y + udy * boardW / 2 };

            // Pole Shadow
            const shorten = 4 * scaleFactor;
            const sdx = shadowTip.x - centerPos.x;
            const sdy = shadowTip.y - centerPos.y;
            const slen = Math.sqrt(sdx * sdx + sdy * sdy);

            g.moveTo(centerPos.x, centerPos.y);
            if (slen > shorten) {
                const f = (slen - shorten) / slen;
                g.lineTo(centerPos.x + sdx * f, centerPos.y + sdy * f);
            } else {
                g.lineTo(shadowTip.x, shadowTip.y);
            }

            // Backboard Shadow (Stroke)
            g.lineStyle(4 * scaleFactor, 0x000000, 0.15);
            g.moveTo(bShadowL.x, bShadowL.y);
            g.lineTo(bShadowR.x, bShadowR.y);

            g.lineStyle(0);
        }

        // Object Drawing
        const vVecP = getRotatedOffset(0, 0.1);
        const vVecN = getRotatedOffset(0, -0.1);
        const dx = vVecP.x - vVecN.x; const dy = vVecP.y - vVecN.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const ndx = dx / len; const ndy = dy / len;

        const bL = { x: centerPos.x - ndx * boardW / 2, y: boardCenterY - ndy * boardW / 2 };
        const bR = { x: centerPos.x + ndx * boardW / 2, y: boardCenterY + ndy * boardW / 2 };
        const bTL = { x: bL.x, y: bL.y - boardH / 2 }; const bTR = { x: bR.x, y: bR.y - boardH / 2 };
        const bBL = { x: bL.x, y: bL.y + boardH / 2 }; const bBR = { x: bR.x, y: bR.y + boardH / 2 };

        const drawPole = () => {
            g.lineStyle(1.5 * scaleFactor, 0x555555);
            g.moveTo(centerPos.x, centerPos.y); g.lineTo(centerPos.x, centerPos.y - poleH);
            g.lineStyle(0);
        };

        const drawBackboard = () => {
            g.beginFill(0xFFFFFF, 0.9);
            g.drawPolygon([bTL, bTR, bBR, bBL]);
            g.endFill();

            g.lineStyle(0.5, 0xCCCCCC);
            g.drawPolygon([bTL, bTR, bBR, bBL]);
            g.lineStyle(0);
        };

        const drawRim = () => {
            const uVecP = getRotatedOffset(0.1, 0); const uVecN = getRotatedOffset(-0.1, 0);
            const udx = uVecP.x - uVecN.x; const udy = uVecP.y - uVecN.y;
            const ulen = Math.sqrt(udx * udx + udy * udy);
            const nudx = udx / ulen; const nudy = udy / ulen;
            const rimDist = 3 * scaleFactor;
            const rimCenter = { x: centerPos.x + nudx * rimDist, y: boardCenterY + nudy * rimDist + (boardH * 0.3) };

            g.lineStyle(1.2 * scaleFactor, 0xFF6600);
            g.moveTo(centerPos.x, boardCenterY + (boardH * 0.3));
            g.lineTo(rimCenter.x, rimCenter.y);

            // Ellipse
            g.drawEllipse(rimCenter.x, rimCenter.y, 2 * scaleFactor, 1 * scaleFactor);
            g.lineStyle(0);
        };

        const isBackView = (rotation === 2 || rotation === 3);

        if (isBackView) {
            drawRim();
            drawBackboard();
            drawPole();
        } else {
            drawPole();
            drawBackboard();
            drawRim();
        }

    } else if (variant === 2) {
        // --- WORKOUT ---
        const barH = 8 * scaleFactor;
        const p1 = getRotatedOffset(-0.2, -0.15);
        const p2 = getRotatedOffset(-0.2, 0.15);
        const dH = 5 * scaleFactor;
        const d1 = getRotatedOffset(0.2, -0.15); const d2 = getRotatedOffset(0.35, -0.15);
        const d3 = getRotatedOffset(0.2, 0.15); const d4 = getRotatedOffset(0.35, 0.15);

        if (showShadows) {
            const s = getShadowShift(barH);
            const sD = getShadowShift(dH);
            // Line shadows for pull-up bar (open structure)
            const tip1 = { x: p1.x + s.x, y: p1.y + s.y };
            const tip2 = { x: p2.x + s.x, y: p2.y + s.y };

            g.lineStyle(1.2 * scaleFactor, 0x000000, 0.15);
            // Post 1 shadow
            g.moveTo(p1.x, p1.y); g.lineTo(tip1.x, tip1.y);
            // Post 2 shadow
            g.moveTo(p2.x, p2.y); g.lineTo(tip2.x, tip2.y);
            // Bar shadow
            g.moveTo(tip1.x, tip1.y); g.lineTo(tip2.x, tip2.y);

            // Dip bar shadows
            const dt1 = { x: d1.x + sD.x, y: d1.y + sD.y };
            const dt2 = { x: d2.x + sD.x, y: d2.y + sD.y };
            const dt3 = { x: d3.x + sD.x, y: d3.y + sD.y };
            const dt4 = { x: d4.x + sD.x, y: d4.y + sD.y };
            g.moveTo(d1.x, d1.y); g.lineTo(dt1.x, dt1.y); g.lineTo(dt2.x, dt2.y); g.lineTo(d2.x, d2.y);
            g.moveTo(d3.x, d3.y); g.lineTo(dt3.x, dt3.y); g.lineTo(dt4.x, dt4.y); g.lineTo(d4.x, d4.y);
            g.lineStyle(0);
        }

        g.lineStyle(1.2 * scaleFactor, 0x555555);
        g.moveTo(p1.x, p1.y); g.lineTo(p1.x, p1.y - barH);
        g.moveTo(p2.x, p2.y); g.lineTo(p2.x, p2.y - barH);

        g.lineStyle(1.0 * scaleFactor, 0x555555);
        g.moveTo(p1.x, p1.y - barH); g.lineTo(p2.x, p2.y - barH);

        // Dip Bars
        g.moveTo(d1.x, d1.y); g.lineTo(d1.x, d1.y - dH); g.lineTo(d2.x, d2.y - dH); g.lineTo(d2.x, d2.y);
        g.moveTo(d3.x, d3.y); g.lineTo(d3.x, d3.y - dH); g.lineTo(d4.x, d4.y - dH); g.lineTo(d4.x, d4.y);
        g.lineStyle(0);

    } else if (variant === 3) {
        // --- TENNIS COURT (Merged Pair) Objects ---
        const postH = 4 * scaleFactor;
        const uSeam = 0.5;

        // ONLY MASTER DRAWS THE NET
        if (isMaster) {
            const p1 = getRotatedOffset(uSeam, -0.4);
            const p2 = getRotatedOffset(uSeam, 0.4);

            // Draw Net Shadows (Lines)
            if (showShadows) {
                g.lineStyle(1.0 * scaleFactor, 0x000000, 0.15);
                const s = getShadowShift(postH);

                const top1 = { x: p1.x, y: p1.y - postH };
                // Add postH back to project shadow to ground level
                const tip1 = { x: top1.x + s.x, y: top1.y + postH + s.y };
                const top2 = { x: p2.x, y: p2.y - postH };
                const tip2 = { x: top2.x + s.x, y: top2.y + postH + s.y };

                g.moveTo(p1.x, p1.y); g.lineTo(tip1.x, tip1.y);
                g.moveTo(p2.x, p2.y); g.lineTo(tip2.x, tip2.y);
                g.moveTo(tip1.x, tip1.y); g.lineTo(tip2.x, tip2.y);
                g.lineStyle(0);
            }

            // Net Geometry
            g.lineStyle(1.5 * scaleFactor, 0x555555);
            // Post 1
            g.moveTo(p1.x, p1.y); g.lineTo(p1.x, p1.y - postH);
            // Post 2
            g.moveTo(p2.x, p2.y); g.lineTo(p2.x, p2.y - postH);
            g.lineStyle(0);

            // Net Mesh
            g.beginFill(0xFFFFFF, 0.3);
            g.drawPolygon([
                { x: p1.x, y: p1.y }, { x: p1.x, y: p1.y - postH },
                { x: p2.x, y: p2.y - postH }, { x: p2.x, y: p2.y }
            ]);
            g.endFill();

            // Top Cable
            g.lineStyle(1 * scaleFactor, 0xFFFFFF, 0.9);
            g.moveTo(p1.x, p1.y - postH); g.lineTo(p2.x, p2.y - postH);
            g.lineStyle(0);
        }
    }
}

// --- VEGETATION HELPERS (PixiJS) ---

function drawPixiTree(g, x, y, showShadows, getShadowShift, shadowColor, shadowNoStroke, heightScale = 1.0, isInShadow = false, isDying = false, showOutlines = false) {
    const scaleFactor = 1.0;
    const trunkW = 3 * scaleFactor * heightScale;
    const trunkH = 6 * scaleFactor * heightScale;
    const foliageRadius = 6 * scaleFactor * heightScale;

    // Shadow
    if (showShadows) {
        g.beginFill(0x000000, 0.15);
        const totalH = trunkH + foliageRadius;
        const s = getShadowShift(totalH);
        const shadowCx = x + s.x;
        const shadowCy = y + s.y; // Ground level projection (no height subtraction)

        // Trunk Shadow (Simplified rect)
        const vx = shadowCx - x, vy = shadowCy - y;
        const dist = Math.sqrt(vx * vx + vy * vy);
        if (dist > 1) {
            const angle = Math.atan2(vy, vx);
            const halfW = trunkW * 0.25;
            const dx = Math.cos(angle + Math.PI / 2) * halfW;
            const dy = Math.sin(angle + Math.PI / 2) * halfW;
            g.drawPolygon([x + dx, y + dy, x - dx, y - dy, shadowCx - dx, shadowCy - dy, shadowCx + dx, shadowCy + dy]);
        }
        g.drawEllipse(shadowCx, shadowCy, foliageRadius * 1.0, foliageRadius * 0.5);
        g.endFill();
    }

    // Colors
    let trunkColor = 0x8B7355;
    let foliageColor = 0x7FCD91;
    let foliageLight = 0xBAFCA2;

    if (isInShadow) { trunkColor = 0x61503b; foliageColor = 0x598f65; foliageLight = 0x82b071; }
    if (isDying) { trunkColor = 0x5a4b37; foliageColor = 0x52855e; foliageLight = 0x79a46a; }

    // Trunk
    g.beginFill(trunkColor);
    g.drawRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
    g.endFill();
    if (showOutlines) {
        g.lineStyle(0.6, 0x000000, 0.4);
        g.drawRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
        g.lineStyle(0);
    }

    // Foliage
    g.beginFill(foliageColor);
    g.drawCircle(x, y - trunkH - foliageRadius + 2, foliageRadius);
    g.endFill();
    if (showOutlines) {
        g.lineStyle(0.6, 0x000000, 0.4);
        g.drawCircle(x, y - trunkH - foliageRadius + 2, foliageRadius);
        g.lineStyle(0);
    }

    // Highlight
    if (showShadows) {
        g.beginFill(foliageLight);
        g.drawCircle(x - 2, y - trunkH - foliageRadius, foliageRadius / 2);
        g.endFill();
    }
}

function drawPixiBush(g, x, y, showShadows, getShadowShift, shadowColor, shadowNoStroke, scale = 1.0, isInShadow = false, isDying = false, showOutlines = false) {
    const radius = 4 * scale;

    if (showShadows) {
        g.beginFill(0x000000, 0.15);
        const s = getShadowShift(radius * 0.5);
        g.drawEllipse(x + s.x, y + s.y, radius, radius * 0.5);
        g.endFill();
    }

    let bodyColor = 0x66BB6A;
    let highColor = 0xA5D6A7;
    if (isInShadow) { bodyColor = 0x47824a; highColor = 0x739675; }
    if (isDying) { bodyColor = 0x427945; highColor = 0x6b8b6d; }

    g.beginFill(bodyColor);
    g.drawCircle(x, y - radius * 0.5, radius);
    g.endFill();
    if (showOutlines) {
        g.lineStyle(0.6, 0x000000, 0.4);
        g.drawCircle(x, y - radius * 0.5, radius);
        g.lineStyle(0);
    }

    if (showShadows) {
        g.beginFill(highColor);
        g.drawCircle(x - radius * 0.3, y - radius * 0.5 - radius * 0.3, radius * 0.4);
        g.endFill();
    }
}

function drawPixiScrub(g, x, y, showShadows, getShadowShift, shadowColor, shadowNoStroke, scale = 1.0, isInShadow = false, isDying = false, showOutlines = false) {
    const r = 2.5 * scale;

    if (showShadows) {
        g.beginFill(0x000000, 0.15);
        const s = getShadowShift(r * 0.5);
        g.drawEllipse(x + s.x, y + s.y, r * 1.5, r * 0.5);
        g.endFill();
    }

    let tuftColor = 0x43A047;
    let tuftHigh = 0x81C784;

    if (isInShadow) { tuftColor = 0x2f7032; tuftHigh = 0x5a8b5c; }
    if (isDying) { tuftColor = 0x2b682e; tuftHigh = 0x548156; }

    const offsets = [{ x: -r * 0.6, y: 0, s: 1.0 }, { x: r * 0.6, y: 0, s: 0.9 }, { x: 0, y: -r * 0.7, s: 1.1 }];

    offsets.forEach(o => {
        g.beginFill(tuftColor);
        g.drawCircle(x + o.x, y + o.y, r * o.s);
        g.endFill();
        if (showOutlines) {
            g.lineStyle(0.6, 0x000000, 0.4);
            g.drawCircle(x + o.x, y + o.y, r * o.s);
            g.lineStyle(0);
        }
        if (showShadows) {
            g.beginFill(tuftHigh);
            g.drawCircle(x + o.x - r * 0.2 * o.s, y + o.y - r * 0.2 * o.s, r * o.s * 0.6);
            g.endFill();
        }
    });
}

// ====== MERGED GREEN (PARK) ======
// Draws a 2-tile merged park: diagonal path, picnic table (aligned to path), trees, bushes
function createMergedPark(x, y, partnerX, partnerY, showShadows, mode, splitMode,
    tileWidth, tileHeight, getShadowShift,
    shadowColor, shadowNoStroke, isoToScreen,
    lightenColor, darkenColor, showOutlines = false) {
    const g = new PIXI.Graphics();

    // --- Geometry Setup ---
    const p1 = isoToScreen(x, y);
    const p2 = isoToScreen(partnerX, partnerY);

    const dx = partnerX - x;
    const isHorizontal = dx === 1;

    // Isometric basis vectors (half-tile)
    const v_u = { x: tileWidth / 2, y: tileHeight / 2 };  // direction x+
    const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };  // direction y+

    // Center of combined area at ground level
    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2 + tileHeight / 2;

    // axisMain = direction the two tiles are merged along
    // axisPerp = perpendicular direction
    let axisMain, axisPerp;
    if (isHorizontal) { axisMain = v_u; axisPerp = v_v; }
    else { axisMain = v_v; axisPerp = v_u; }

    // Half-extents
    const L = 1.02; // half-length along merge axis - Extended to full 2-tile span (was 0.48)
    const W = 0.44; // half-width perpendicular

    // Convert (u,v) in [-1,1]² to screen coords inside the merged area
    const areaPoint = (u, v) => ({
        x: cx + axisMain.x * u * L + axisPerp.x * v * W,
        y: cy + axisMain.y * u * L + axisPerp.y * v * W
    });

    // --- Deterministic seed ---
    let _seed = (x * 137 + y * 149 + partnerX * 31 + partnerY * 47) & 0xFFFFFF;
    const seedRand = () => {
        _seed = (_seed * 1664525 + 1013904223) & 0xFFFFFF;
        return _seed / 0xFFFFFF;
    };

    // ── Pre-roll stable values ──
    const pathDrift = 0.18;
    // Table placement: alongside path, on one side
    const tSide = seedRand() < 0.5 ? 1 : -1;
    // Push table slightly more towards center-ish of that side
    const tU = seedRand() * 0.4 - 0.2;
    const tV = tSide * 0.55;

    // Table center
    const tableX = cx + axisMain.x * tU * L + axisPerp.x * tV * W;
    const tableY = cy + axisMain.y * tU * L + axisPerp.y * tV * W;

    // ── ICONIC PICNIC TABLE ──
    const sf = tileHeight / 30;
    // Dimensions
    const tabLen = 10 * sf;
    const tabWid = 5 * sf;
    const tabH = 4.5 * sf;  // Height of table top
    const benchH = 2.2 * sf; // Height of benches
    const benchWid = 1.5 * sf;
    const benchOff = 3.5 * sf; // Distance from center to bench center

    // Geometry Helpers
    // Normalised vectors
    const axisMainLen = Math.sqrt(axisMain.x * axisMain.x + axisMain.y * axisMain.y);
    const axisPerpLen = Math.sqrt(axisPerp.x * axisPerp.x + axisPerp.y * axisPerp.y);
    const nM = { x: axisMain.x / axisMainLen, y: axisMain.y / axisMainLen }; // Length-wise
    const nP = { x: axisPerp.x / axisPerpLen, y: axisPerp.y / axisPerpLen }; // Width-wise

    // Get point relative to table center
    // u: along length (-0.5 .. 0.5), v: along width
    // z: height
    const tPoint = (u, v, z) => ({
        x: tableX + nM.x * u * tabLen + nP.x * v + (showShadows && mode === 'SHADOW' ? getShadowShift(z).x : 0),
        y: tableY + nM.y * u * tabLen + nP.y * v - z + (showShadows && mode === 'SHADOW' ? getShadowShift(z).y : 0)
    });

    // Drawing Helpers
    const drawQuad = (p1, p2, p3, p4, color, alpha = 1) => {
        g.beginFill(color, alpha);
        g.drawPolygon([p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y]);
        g.endFill();
    };

    // A-Frame Leg Triangle
    const drawALeg = (uPos) => {
        // A-shape: Bottom Left, Top Center, Bottom Right
        // But for 3D effect we need thickness. 
        // Let's keep it simple: Thick angled legs.

        // Leg Spread at bottom
        const spread = benchOff + benchWid;

        // Points
        const pTop = tPoint(uPos, 0, tabH - 0.5 * sf); // Tucked under top
        const pBotL = tPoint(uPos, -spread, 0);
        const pBotR = tPoint(uPos, spread, 0);

        // Draw Triangle
        g.lineStyle(1.5 * sf, 0x5D4037); // Dark Wood
        g.moveTo(pBotL.x, pBotL.y);
        g.lineTo(pTop.x, pTop.y);
        g.lineTo(pBotR.x, pBotR.y);
        g.lineStyle(0);

        // Horizontal Crossbar for benches
        const pCrossL = tPoint(uPos, -spread * 0.8, benchH);
        const pCrossR = tPoint(uPos, spread * 0.8, benchH);
        g.lineStyle(1.2 * sf, 0x5D4037);
        g.moveTo(pCrossL.x, pCrossL.y);
        g.lineTo(pCrossR.x, pCrossR.y);
        g.lineStyle(0);
    };

    // --- SHADOW pass ---
    if (mode === 'SHADOW' && showShadows) {
        g.beginFill(0x000000, 0.18);

        // Simple bounding shadow for the whole group
        // Just approximate with a big rectangle
        const sSize = tabLen * 0.7;
        const sW = tabWid * 2;

        const sa = tPoint(-0.6, -sW / tabLen * 3, 0);
        const sb = tPoint(0.6, -sW / tabLen * 3, 0);
        const sc = tPoint(0.6, sW / tabLen * 3, 0);
        const sd = tPoint(-0.6, sW / tabLen * 3, 0);

        g.drawPolygon([sa.x, sa.y, sb.x, sb.y, sc.x, sc.y, sd.x, sd.y]);
        g.endFill();
        return g;
    }

    // --- BUILDING pass ---
    if (mode === 'BUILDING') {

        // ── A. PATH ─────────────────────────────────────────────────────────
        // ── A. PATH ─────────────────────────────────────────────────────────
        const pathW = 0.20;
        // Extended L slightly to ensure edge-to-edge coverage (0.51)
        const pa = areaPoint(-1.0, -pathW);
        const pb = areaPoint(-1.0, pathW);
        const pc = areaPoint(1.0, pathW); // No drift (Straight)
        const pd = areaPoint(1.0, -pathW); // No drift

        g.beginFill(0xEEDCBA, 1.0); // Garden Terrace Color
        g.drawPolygon([pa.x, pa.y, pb.x, pb.y, pc.x, pc.y, pd.x, pd.y]);
        g.endFill();
        // Subtle depth edge
        g.beginFill(0xD2B48C, 0.28); // Slightly darker for depth
        g.drawPolygon([pb.x, pb.y, pc.x, pc.y,
        pc.x + axisPerp.x * 0.03 * W, pc.y + axisPerp.y * 0.03 * W,
        pb.x + axisPerp.x * 0.03 * W, pb.y + axisPerp.y * 0.03 * W]);
        g.endFill();

        // ── B. ICONIC PICNIC TABLE ──

        // 1. Legs (A-Frames) - Draw first so they are behind/under
        drawALeg(-0.35);
        drawALeg(0.35);

        // 2. Benches (Left and Right)
        const woodColor = 0xA1887F;
        const woodDark = 0x8D6E63;
        const woodLight = 0xD7CCC8;

        const drawPlank = (vOffset, z, width, lengthScale = 1.0) => {
            const hL = lengthScale * 0.5;
            const w2 = width / 2;

            // Tops ONLY (Simplified)
            const pt1 = tPoint(-hL, vOffset - w2, z);
            const pt2 = tPoint(hL, vOffset - w2, z);
            const pt3 = tPoint(hL, vOffset + w2, z);
            const pt4 = tPoint(-hL, vOffset + w2, z);

            drawQuad(pt1, pt2, pt3, pt4, woodLight);

            // Side thickness removed for simpler look
        };

        // Draw Benches
        drawPlank(-benchOff, benchH, benchWid * 1.5);
        drawPlank(benchOff, benchH, benchWid * 1.5);

        // Draw Table Top
        drawPlank(0, tabH, tabWid, 1.1); // Slightly longer/wider

        // ── C. TREES & BUSHES (Spread Out) ──
        // Strategy: Divide area into grid logic or use rejection sampling that prefers edges.

        const treeScale = tileHeight / 30;
        const numTrees = 3 + (seedRand() < 0.3 ? 1 : 0);

        // Define "exclusion zone" around table
        const minTableDistSq = (tileWidth * 0.25) * (tileWidth * 0.25);

        // Pre-generate positions
        const vegePositions = [];

        for (let i = 0; i < numTrees; i++) {
            let tp;
            // Try 4 corners first for better spread
            if (i < 4) {
                // Map i to a quadrant: 0:TL, 1:TR, 2:BL, 3:BR
                const uDir = (i % 2 === 0) ? -1 : 1;
                const vDir = (i < 2) ? -1 : 1;

                // Randomize, pushing towards edges (0.6 to 1.0 range)
                const u = uDir * (0.6 + seedRand() * 0.4);
                const v = vDir * (0.6 + seedRand() * 0.4);

                tp = areaPoint(u, v);
            } else {
                // Random fill
                const ru = seedRand() * 2.0 - 1.0;
                const rv = seedRand() * 2.0 - 1.0;
                tp = areaPoint(ru, rv);
            }

            // Simple distance check against table
            const distX = tp.x - tableX;
            const distY = tp.y - tableY;
            if (distX * distX + distY * distY > minTableDistSq) {
                vegePositions.push({ type: 'TREE', pos: tp });
            }
        }

        // Bushes
        const numBushes = 2 + Math.floor(seedRand() * 3);
        for (let i = 0; i < numBushes; i++) {
            const ru = seedRand() * 1.8 - 0.9;
            const rv = seedRand() * 1.8 - 0.9;
            const pt = areaPoint(ru, rv);
            // Simple distance check against table
            const distX = pt.x - tableX;
            const distY = pt.y - tableY;
            if (distX * distX + distY * distY > minTableDistSq) {
                vegePositions.push({ type: 'BUSH', pos: pt });
            }
        }

        // Sort by Y for painter's algorithm
        vegePositions.sort((a, b) => a.pos.y - b.pos.y);

        for (const item of vegePositions) {
            if (item.type === 'TREE') {
                const tVar = Math.floor(seedRand() * 3);
                window.drawPixiTree(g, item.pos.x, item.pos.y, showShadows, getShadowShift, shadowColor, shadowNoStroke, treeScale * (0.9 + seedRand() * 0.3), tVar, false, showOutlines);
            } else {
                const isScrub = seedRand() < 0.4;
                if (isScrub) {
                    window.drawPixiScrub(g, item.pos.x, item.pos.y, showShadows, getShadowShift, shadowColor, shadowNoStroke, treeScale * 0.8 * 0.8, false, false, showOutlines);
                } else {
                    window.drawPixiBush(g, item.pos.x, item.pos.y, showShadows, getShadowShift, shadowColor, shadowNoStroke, treeScale * 0.8, false, false, showOutlines);
                }
            }
        }
    }

    return g;
}

function createFarmingBuilding(x, y, showShadows, mode, tileWidth, tileHeight, getShadowShift, shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor, baseColor, quadrant, hSeed, dataGrid, numCols, numRows, showOutlines) {
    const g = new PIXI.Graphics();

    // Geometry Constants
    const bWidth = tileWidth * 0.33;
    const bHeight = tileHeight * 0.33;

    // Height Variant
    const hVariant = Math.abs(hSeed) % 3;
    let heightFactor = 0.3;
    if (hVariant === 1) heightFactor = 0.25;
    else if (hVariant === 2) heightFactor = 0.35;
    const blockZ = tileHeight * heightFactor;

    // Offset based on Quadrant
    let offsetX = 0, offsetY = 0;
    if (quadrant === 0) { offsetX = 0; offsetY = -tileHeight / 3; }
    else if (quadrant === 1) { offsetX = tileWidth / 3; offsetY = 0; }
    else if (quadrant === 2) { offsetX = 0; offsetY = tileHeight / 3; }
    else if (quadrant === 3) { offsetX = -tileWidth / 3; offsetY = 0; }

    const sp = isoToScreen(x, y);
    const startX = sp.x + offsetX;
    const startY = sp.y + tileHeight / 2 + offsetY - (bHeight / 2);

    // Vertices
    const top = { x: startX, y: startY - blockZ };
    const right = { x: startX + bWidth / 2, y: startY + bHeight / 2 - blockZ };
    const bottom = { x: startX, y: startY + bHeight - blockZ };
    const left = { x: startX - bWidth / 2, y: startY + bHeight / 2 - blockZ };

    // Base Points (for Shadow)
    const bL = { x: startX - bWidth / 2, y: startY + bHeight / 2 };
    const bR = { x: startX + bWidth / 2, y: startY + bHeight / 2 };
    const bB = { x: startX, y: startY + bHeight };

    // --- SHADOW ---
    if (showShadows || mode === 'SHADOW') {
        g.beginFill(0x000000, 0.2); // PIXI needs hex + alpha
        const s = getShadowShift(blockZ);

        // Use base-level points (no -blockZ) shifted by shadow offset
        const bTop = { x: startX, y: startY };
        const bRight2 = { x: startX + bWidth / 2, y: startY + bHeight / 2 };
        const bBottom2 = { x: startX, y: startY + bHeight };
        const bLeft2 = { x: startX - bWidth / 2, y: startY + bHeight / 2 };

        const pL = { x: bLeft2.x + s.x, y: bLeft2.y + s.y };
        const pR = { x: bRight2.x + s.x, y: bRight2.y + s.y };
        const pB = { x: bBottom2.x + s.x, y: bBottom2.y + s.y };
        const pT = { x: bTop.x + s.x, y: bTop.y + s.y };

        g.drawPolygon([
            bLeft2.x, bLeft2.y,
            bRight2.x, bRight2.y,
            pR.x, pR.y,
            pB.x, pB.y,
            pL.x, pL.y,
            pT.x, pT.y
        ]);
        g.endFill();
        if (mode === 'SHADOW') return g;
    }

    // --- BUILDING ---
    if (mode === 'BUILDING' || mode === 'ALL') {
        // 1. Top Face
        g.beginFill(lightenColor(baseColor, 30));
        g.drawPolygon([top.x, top.y, right.x, right.y, bottom.x, bottom.y, left.x, left.y]);
        g.endFill();

        // 2. Left Face
        g.beginFill(darkenColor(baseColor, 15));
        g.drawPolygon([left.x, left.y, bottom.x, bottom.y, bottom.x, bottom.y + blockZ, left.x, left.y + blockZ]);
        g.endFill();

        // 3. Right Face
        g.beginFill(darkenColor(baseColor, 25));
        g.drawPolygon([bottom.x, bottom.y, right.x, right.y, right.x, right.y + blockZ, bottom.x, bottom.y + blockZ]);
        g.endFill();

        // 4. Outlines (Conditional)
        if (showOutlines) {
            const strokeColor = 0x000000;
            const strokeAlpha = 0.8;
            const dividerAlpha = 0.4;
            const sf = tileHeight / 30;
            const thin = 0.5 * sf;
            const thick = 1.0 * sf;

            const getQuad = (nx, ny) => {
                if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) return -1;
                return dataGrid[ny][nx].occupiedQuad;
            };
            const checkAdj = (nx, ny, validQuads) => {
                const nq = getQuad(nx, ny);
                return validQuads.includes(nq);
            };

            const q = quadrant;
            const nRight = (q === 1 || q === 2) && checkAdj(x + 1, y, [0, 3, 4]);
            const nLeft = (q === 0 || q === 3) && checkAdj(x - 1, y, [1, 2, 4]);
            const nBottom = (q === 2 || q === 3) && checkAdj(x, y + 1, [0, 1, 4]);
            const nTop = (q === 0 || q === 1) && checkAdj(x, y - 1, [2, 3, 4]);

            const drawLine = (p1, p2, isThick) => {
                g.lineStyle(isThick ? thick : thin, strokeColor, isThick ? strokeAlpha : dividerAlpha);
                g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y);
                g.lineStyle(0);
            };

            // Inner Folds
            drawLine(bottom, right, false);
            drawLine(bottom, left, false);
            drawLine(bottom, { x: bottom.x, y: bottom.y + blockZ }, false);

            // Silhouette / Edges
            drawLine(top, right, !nTop);
            drawLine(top, left, !nLeft);

            const bRight = { x: right.x, y: right.y + blockZ };
            const bBottom = { x: bottom.x, y: bottom.y + blockZ };
            const bLeft = { x: left.x, y: left.y + blockZ };

            drawLine(right, bRight, !(nRight || nTop));
            drawLine(bBottom, bRight, !nRight);
            drawLine(left, bLeft, !(nLeft || nBottom));
            drawLine(bBottom, bLeft, !nBottom);
        }
    }
    return g;
}

// Helper for Simple Block Buildings (Existing)
// Helper for Simple Block Buildings (Existing)

// Helper for Simple Block Buildings (Existing)
window.drawSimpleBuilding = (g, x, y, tileWidth, tileHeight, heightScale, color, showShadows, getShadowShift, shadowColor, isoToScreen, lightenColor, darkenColor, neighbors = {}, editSq = 0, doors = {}) => {
    // Helper: Convert CSS color string to Hex Number for PIXI
    const cssToHex = (cssColor) => {
        if (typeof cssColor === 'number') return cssColor;
        if (!cssColor) return 0xFFFFFF;
        // Check for specific color names if used (e.g. 'white', 'red') - though we mostly use hex strings
        if (cssColor.startsWith('#')) {
            return parseInt(cssColor.replace('#', ''), 16);
        }
        // Handle rgba/rgb strings if necessary, but we mostly use hex.
        // Simple fallback for now:
        return 0xCCCCCC;
    };

    const sp = isoToScreen(x, y);
    const sf = tileHeight / 30;
    const blockZ = tileHeight * heightScale;

    // Neighbors
    const nTop = neighbors.top || false;
    const nRight = neighbors.right || false;
    const nBottom = neighbors.bottom || false;
    const nLeft = neighbors.left || false;
    const nTopLeft = neighbors.topLeft || false;
    const nTopRight = neighbors.topRight || false;
    const nBottomRight = neighbors.bottomRight || false;
    const nBottomLeft = neighbors.bottomLeft || false;

    // SCALING / MERGING LOGIC
    // Base scale is 0.8 (recessed).
    // If a neighbor exists, scale on that side is 1.0 (merged).
    const inset = 0.1; // 10% inset per side

    // Factors for each side (1.0 = full, 0.8 = recessed relative to center? No, 1.0 means edge.)
    // We define "inset factor" where 0 = edge, 0.1 = recessed.
    const iTop = nTop ? 0 : inset;
    const iRight = nRight ? 0 : inset;
    const iBottom = nBottom ? 0 : inset;
    const iLeft = nLeft ? 0 : inset;

    // Geometry (Screen Space)
    // Center of tile (Ground)
    const hW = tileWidth / 2;
    const hH = tileHeight / 2;
    const cx = sp.x;
    const cy = sp.y + hH;

    // Coordinate System (U, V) relative to center
    // U goes to Bottom-Right (x+). Range [-0.5, 0.5]
    // V goes to Bottom-Left (y+). Range [-0.5, 0.5]

    // U Max (Wall with Right Neighbor, x+1): 0.5 - iRight
    // U Min (Wall with Left Neighbor, x-1): -0.5 + iLeft
    // V Max (Wall with Bottom Neighbor, y+1): 0.5 - iBottom
    // V Min (Wall with Top Neighbor, y-1): -0.5 + iTop

    const uMax = 0.5 - iRight;
    const uMin = -0.5 + iLeft;
    const vMax = 0.5 - iBottom;
    const vMin = -0.5 + iTop;

    const isoToPoint = (u, v) => ({
        x: cx + (u - v) * hW,
        y: cy + (u + v) * hH
    });

    // Building Corners (Base)
    // Top Corner: (uMin, vMin)
    const bTop = isoToPoint(uMin, vMin);
    // Right Corner: (uMax, vMin)
    const bRight = isoToPoint(uMax, vMin);
    // Bottom Corner: (uMax, vMax)
    const bBottom = isoToPoint(uMax, vMax);
    // Left Corner: (uMin, vMax)
    const bLeft = isoToPoint(uMin, vMax);


    // Roof Corners (Shifted up by blockZ)
    const rTop = { x: bTop.x, y: bTop.y - blockZ };
    const rRight = { x: bRight.x, y: bRight.y - blockZ };
    const rBottom = { x: bBottom.x, y: bBottom.y - blockZ };
    const rLeft = { x: bLeft.x, y: bLeft.y - blockZ };


    // DOORMATS
    // Only draw if there is a gap (inset > 0) AND a door exists.

    // 1. Top Neighbor (y-1) -> vMin Edge. (Visual Top-Right: bTop to bRight).
    if (doors.top && doors.top.exists && iTop > 0) {
        g.beginFill(cssToHex(doors.top.color));
        g.drawPolygon([
            isoToPoint(uMin, -0.5).x, isoToPoint(uMin, -0.5).y,
            isoToPoint(uMax, -0.5).x, isoToPoint(uMax, -0.5).y,
            isoToPoint(uMax, vMin).x, isoToPoint(uMax, vMin).y,
            isoToPoint(uMin, vMin).x, isoToPoint(uMin, vMin).y
        ]);
        g.endFill();
    }

    // 2. Right Neighbor (x+1) -> uMax Edge.
    if (doors.right && doors.right.exists && iRight > 0) {
        g.beginFill(cssToHex(doors.right.color));
        g.drawPolygon([
            isoToPoint(uMax, vMin).x, isoToPoint(uMax, vMin).y, // bRight
            isoToPoint(0.5, vMin).x, isoToPoint(0.5, vMin).y,
            isoToPoint(0.5, vMax).x, isoToPoint(0.5, vMax).y,
            isoToPoint(uMax, vMax).x, isoToPoint(uMax, vMax).y  // bBottom
        ]);
        g.endFill();
    }

    // 3. Bottom Neighbor (y+1) -> vMax Edge.
    if (doors.bottom && doors.bottom.exists && iBottom > 0) {
        g.beginFill(cssToHex(doors.bottom.color));
        g.drawPolygon([
            isoToPoint(uMax, vMax).x, isoToPoint(uMax, vMax).y, // bBottom
            isoToPoint(uMax, 0.5).x, isoToPoint(uMax, 0.5).y,
            isoToPoint(uMin, 0.5).x, isoToPoint(uMin, 0.5).y,
            isoToPoint(uMin, vMax).x, isoToPoint(uMin, vMax).y  // bLeft
        ]);
        g.endFill();
    }

    // 4. Left Neighbor (x-1) -> uMin Edge.
    if (doors.left && doors.left.exists && iLeft > 0) {
        g.beginFill(cssToHex(doors.left.color));
        g.drawPolygon([
            isoToPoint(uMin, vMax).x, isoToPoint(uMin, vMax).y, // bLeft
            isoToPoint(-0.5, vMax).x, isoToPoint(-0.5, vMax).y, // Top-Left of Left Edge
            isoToPoint(-0.5, vMin).x, isoToPoint(-0.5, vMin).y, // Top-Right of Left Edge (visually Top-Top-Left?)
            isoToPoint(uMin, vMin).x, isoToPoint(uMin, vMin).y  // bTop
        ]);
        g.endFill();
    }


    // SHADOWS
    if (showShadows) {
        // Project BASE footprint along light direction to get ground shadow
        const shift = getShadowShift(blockZ);
        const sTop = { x: bTop.x + shift.x, y: bTop.y + shift.y };
        const sRight = { x: bRight.x + shift.x, y: bRight.y + shift.y };
        const sBottom = { x: bBottom.x + shift.x, y: bBottom.y + shift.y };
        const sLeft = { x: bLeft.x + shift.x, y: bLeft.y + shift.y };

        g.beginFill(0x000000, 0.2);
        g.drawPolygon([sTop.x, sTop.y, sRight.x, sRight.y, sBottom.x, sBottom.y, sLeft.x, sLeft.y]);
        g.endFill();
    }

    // DRAW BLOCK
    // 1. Left Face (bLeft, bBottom, rBottom, rLeft) - VISIBLE unless occluded?
    // Always visible in standard iso view order (painter's algorithm handles tile sorting)
    // Actually, we usually draw Left and Right faces. Top is roof.
    // Back faces (Top-Left, Top-Right) are hidden.
    // Visual Left Face: bBottom -> bLeft -> rLeft -> rBottom
    g.beginFill(darkenColor(color, 20));
    g.drawPolygon([bLeft.x, bLeft.y, bBottom.x, bBottom.y, rBottom.x, rBottom.y, rLeft.x, rLeft.y]);
    g.endFill();

    // 2. Right Face (bRight, bBottom, rBottom, rRight)
    g.beginFill(darkenColor(color, 40)); // Slightly darker for contrast
    g.drawPolygon([bBottom.x, bBottom.y, bRight.x, bRight.y, rRight.x, rRight.y, rBottom.x, rBottom.y]);
    g.endFill();

    // 3. Roof (rTop, rRight, rBottom, rLeft)
    g.beginFill(color);
    g.drawPolygon([rTop.x, rTop.y, rRight.x, rRight.y, rBottom.x, rBottom.y, rLeft.x, rLeft.y]);
    g.endFill();

    // Outlines (Optional - if shadows off) — neighbor-aware to merge adjacent EXISTING tiles
    if (!showShadows && editSq === 1) {
        const strokeColor = 0x000000;
        const strokeAlpha = 0.5;
        g.lineStyle(2 * sf, strokeColor, strokeAlpha);

        // Outline the outer perimeter only — each edge/corner drawn only when the neighbor on that side is absent
        // Roof edges (one per side)
        if (!nTop)    { g.moveTo(rTop.x, rTop.y);     g.lineTo(rRight.x, rRight.y); }
        if (!nRight)  { g.moveTo(rRight.x, rRight.y); g.lineTo(rBottom.x, rBottom.y); }
        if (!nBottom) { g.moveTo(rBottom.x, rBottom.y); g.lineTo(rLeft.x, rLeft.y); }
        if (!nLeft)   { g.moveTo(rLeft.x, rLeft.y);   g.lineTo(rTop.x, rTop.y); }
        // Vertical corner edges — only the two visible face corners (bBottom and bLeft are on visible faces)
        // bTop and bRight face away from the camera and are never visible
        if (!nBottom && !nRight) { g.moveTo(bBottom.x, bBottom.y); g.lineTo(rBottom.x, rBottom.y); }
        if (!nBottom && !nLeft)  { g.moveTo(bLeft.x, bLeft.y);   g.lineTo(rLeft.x, rLeft.y); }

        g.lineStyle(0);
    }
};

