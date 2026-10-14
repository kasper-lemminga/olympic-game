// Wait for DOM to load
window.addEventListener('DOMContentLoaded', () => {
    console.log("Application starting...");

    // PIXI.js Initialization
    const canvas = document.getElementById('myCanvas');

    // TOUCH / TABLET
    // Switches on automatically on touch screens (coarse pointer): bigger buttons, docked info text and a capped
    // render resolution (tablet screens have a high pixel density, which is heavy for their GPU).
    // The input handling itself checks per event whether it came from a finger or a mouse.
    const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
    const TOUCH_MAX_RESOLUTION = 1.5;
    if (IS_TOUCH) document.body.classList.add('touch');

    // EXHIBITION MODE (graduation show, unattended tablet)
    // Hides the file/export/settings buttons, starts with the exhibition layout (expo_layout.js), splits Reset
    // (back to that layout) from Clear (empty grid) and returns to the start screen after a period without input.
    const EXPO_MODE = true;
    const EXPO_IDLE_MS = 3 * 60 * 1000;
    if (EXPO_MODE) document.body.classList.add('expo');

    // Create Pixi Application
    const app = new PIXI.Application({
        view: canvas,
        width: canvas.parentElement.clientWidth,
        height: canvas.parentElement.clientHeight,
        backgroundAlpha: 0, // CRITICAL: Start transparent to ensure WebGL context supports alpha
        resolution: IS_TOUCH ? Math.min(window.devicePixelRatio || 1, TOUCH_MAX_RESOLUTION) : (window.devicePixelRatio || 1),
        autoDensity: true,
        antialias: true,
        preserveDrawingBuffer: true // CRITICAL: Required for toDataURL() export to work
    });

    // Immediately restore the opaque grey background for the app interface
    app.renderer.background.color = 0xE2E8F0;
    app.renderer.background.alpha = 1;

    // Viewport Setup (Simulates Camera)
    const viewport = new pixi_viewport.Viewport({
        screenWidth: app.view.width,
        screenHeight: app.view.height,
        worldWidth: 2000,
        worldHeight: 2000,
        events: app.renderer.events, // InteractionManager
        passiveWheel: false,
    });

    app.stage.addChild(viewport);

    viewport
        .drag({ mouseButtons: 'right' })
        .pinch()
        .wheel({ smooth: 5 })
        .clampZoom({ minScale: 0.1, maxScale: 4.0 });

    canvas.addEventListener('wheel', () => { markInteracting(); }, { passive: true });

    // Grid System
    const tileContainers = []; // 2D Array of Containers [y][x]

    // Dark Mode Logic
    const darkModeToggle = document.getElementById('darkModeToggle');
    const isDarkMode = localStorage.getItem('darkMode') === 'true';
    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        darkModeToggle.textContent = '☀️ Light';
        app.renderer.background.color = 0x1a1a1a;
    }

    darkModeToggle.addEventListener('click', () => {
        const isDark = document.body.classList.toggle('dark-mode');
        localStorage.setItem('darkMode', isDark);
        darkModeToggle.textContent = isDark ? '☀️ Light' : '🌙 Dark';
        app.renderer.background.color = isDark ? 0x1a1a1a : 0xE2E8F0;

        // Re-build grid to update colors
        buildGrid();
    });
    darkModeToggle.addEventListener('mouseenter', () => updateInfoBox(darkModeToggle.dataset.info));
    darkModeToggle.addEventListener('mouseleave', () => updateInfoBox(""));

    const saveLayoutBtn = document.getElementById('saveLayout');
    const loadLayoutBtn = document.getElementById('loadLayoutBtn');

    loadLayoutBtn.addEventListener('mouseenter', () => updateInfoBox(loadLayoutBtn.dataset.info));
    loadLayoutBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    // KPI Tooltips
    document.querySelectorAll('.kpi-card').forEach(card => {
        card.addEventListener('mouseenter', () => updateInfoBox(card.dataset.info));
        card.addEventListener('mouseleave', () => updateInfoBox(""));
    });

    let numCols = 30; // Default grid size
    let numRows = 30;

    // View State (Synced with Viewport)
    // We keep viewState for legacy logic if needed, but primarily use viewport
    const viewState = {
        zoom: 0.9,
        panX: 0,
        panY: 30,
        isDragging: false
    };

    // Pause on Interaction State
    let wasPausedByInteraction = false;
    let zoomInteractionTimer = null;

    // Interaction State
    let hoveredCell = null;
    let lastTickTime = Date.now();

    // START FIX: Lifting Layout Maps to Closure Scope for Export Access
    let workshopLayouts = new Map();
    let sportLayouts = new Map();
    let layoutsDirty = true; // Recompute layouts when data changes (ticks, paint)
    // END FIX

    // PERFORMANCE: Render Loop Variables
    let renderRequested = false;
    let worldDirty = false;

    // INCREMENTAL RENDERING
    // After a simulation tick, buildWorld() only redraws the tiles whose own plot changed, or where a
    // directly adjacent plot changed in a way a neighbour can see (type, colour, merge, paths, zone).
    // All other tiles keep their existing PIXI containers.
    // While panning/zooming, tiles that stay in view are kept as well; only tiles that scroll into view are drawn.
    // Every other render request (painting, toggles, sliders, LOD/shadow changes, export) still rebuilds everything.
    // Set INCREMENTAL_RENDER to false to always rebuild everything (the old behaviour).
    const INCREMENTAL_RENDER = true;
    const INCR_RADIUS = 1;        // how far a plot's type/colour/merge/paths influence other tiles
    const groundLayer = new PIXI.Container(); // ground tiles, row-major (painter's order)
    const objectLayer = new PIXI.Container(); // 3D objects + shadows, drawn on top of all ground tiles
    let objGraphicRefs = [];       // 2D array: objGraphicRefs[y][x] = PIXI.Container
    let fullRebuildNeeded = true;  // set by every render request that is not a simulation tick
    let _lastPlotSigs = null;      // per-plot signatures of what is currently drawn
    let _lastNeighbourSigs = null; // the part of those signatures that neighbouring tiles depend on
    let _lastCtxKey = null;        // global render settings of what is currently drawn
    let _lastSigRange = null;      // tile range the signatures above were computed for
    let _lastBuiltRange = null;    // visible tile range of what is currently drawn

    function requestRender() {
        // Mark world as dirty so the next frame triggers a rebuild
        worldDirty = true;
        fullRebuildNeeded = true;
    }

    // LOD (Level of Detail) System
    let currentLOD = 0;
    let lodEnabled = localStorage.getItem('lodEnabled') !== 'false';
    function getLODLevel(scale) {
        if (!lodEnabled) return 0;
        if (scale < 0.2) return 2;
        if (scale < 0.45) return 1;
        return 0;
    }

    function gameLoop() {
        requestAnimationFrame(gameLoop);

        // LOD: check if zoom crossed a threshold
        const newLOD = getLODLevel(viewport.scale.x);
        if (newLOD !== currentLOD) {
            currentLOD = newLOD;
            worldDirty = true;
        }

        // Viewport culling: check if visible tile range shifted by ≥2 tiles
        // (hysteresis prevents rebuilds during smooth zoom animations)
        const newRange = getVisibleTileRange();
        if (lastVisibleRange &&
            (Math.abs(newRange.startX - lastVisibleRange.startX) >= 2 ||
                Math.abs(newRange.endX - lastVisibleRange.endX) >= 2 ||
                Math.abs(newRange.startY - lastVisibleRange.startY) >= 2 ||
                Math.abs(newRange.endY - lastVisibleRange.endY) >= 2)) {
            worldDirty = true;
        }

        // --- INTRO MODAL CHECK (Once per load) ---
        if (!introShown) {
            checkIntro();
            introShown = true;
        }

        if (worldDirty || renderRequested) {
            buildWorld(false, true);
            worldDirty = false;
            renderRequested = false;
            lastVisibleRange = newRange;
        }

        // Calculate Progress (Smooth Interpolation)
        if (simulationInterval && simulationParameters.tickSpeed > 0) {
            const now = Date.now();
            const elapsed = now - lastTickTime;
            tickProgress = Math.min(100, (elapsed / simulationParameters.tickSpeed) * 100);
        }

        if (typeof updateProgressBarFixed === 'function') updateProgressBarFixed(); // Use function reference
    }

    let introShown = false;

    // --- MODAL SYSTEM LOGIC ---
    const modalOverlay = document.getElementById('app-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalCloseBtn = document.getElementById('modal-close-btn');

    function showModal(title, contentHtml) {
        if (!modalOverlay) return;
        modalTitle.textContent = title;
        modalBody.innerHTML = contentHtml;
        modalOverlay.classList.add('active');
        wasPausedByInteraction = !!simulationInterval; // Remember state
        if (simulationInterval) toggleSimulation(); // Pause sim when modal opens
    }

    function closeModal() {
        if (!modalOverlay) return;
        modalOverlay.classList.remove('active');
        modalBody.innerHTML = ''; // Clear content
        if (wasPausedByInteraction && !simulationInterval) toggleSimulation(); // Resume if it was running
    }

    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeModal();
        });
    }

    // --- INTRO SCREEN CONTENT ---
    function checkIntro() {
        const skip = localStorage.getItem('skipIntro');
        if (skip === 'true') return;

        const controlItem = (key, text) => `<div style="display: flex; align-items: center; gap: 8px;"><div style="width: 6px; height: 6px; background: #000;"></div> <span style="font-weight: 700; color: #2D3748;">${key}:</span> ${text}</div>`;
        const controlsHtml = IS_TOUCH
            ? controlItem('Tap', 'Paint / Select') + controlItem('Two fingers', 'Pan &amp; Zoom') +
              controlItem('Eraser button', 'Erase') + controlItem('Simulation', 'Drag with one finger to pan')
            : controlItem('Left Click', 'Paint / Select') + controlItem('Right Drag', 'Pan View') +
              controlItem('Shift + Click', 'Erase') + controlItem('Scroll', 'Zoom');
        const skipHtml = EXPO_MODE ? '' : `
                        <label style="margin-left: auto; font-size: 0.8rem; color: #718096; cursor: pointer; display: flex; align-items: center; gap: 8px; text-transform: uppercase;">
                            <input type="checkbox" id="intro-skip-check" style="accent-color: #000;"> Don't show again
                        </label>`;

        const introHtml = `
            <div style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; font-family: 'Inter', sans-serif;">
                <div style="padding: 40px; flex: 1; overflow-y: auto;">
                    <h1 style="font-size: 1.5rem; margin-bottom: 24px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #E2E8F0; padding-bottom: 12px;">Olympic Village Planner</h1>
                    
                    <p style="font-size: 1.1rem; color: #2d3748; line-height: 1.6; margin-bottom: 24px;">
                        This simulation is part of my graduation project at the Academy of Architecture. Its goal is to visualize a rule-based design approach. Use the tools to paint the grid and watch the village evolve!
                    </p>
                    ${EXPO_MODE ? `<p style="font-size: 1rem; color: #4A5568; line-height: 1.6; margin-bottom: 24px;">
                        The grid starts with an example zoning layout. Press <b>Start Simulation</b> to watch it develop, <b>⟳</b> to go back to the example, or <b>✕</b> to clear the grid and draw your own.
                    </p>` : ''}
    
                    <div style="display: flex; gap: 16px; align-items: center; margin-bottom: 32px;">
                        <button id="intro-start-btn" style="padding: 12px 24px; font-size: 0.9rem; font-weight: 700; text-transform: uppercase; background: #000; color: #fff; border: 1px solid #000; border-radius: 0; cursor: pointer; transition: all 0.2s;">Start Designing</button>
                        <button id="intro-manual-btn" style="padding: 12px 24px; font-size: 0.9rem; font-weight: 600; text-transform: uppercase; background: #fff; color: #2d3748; border: 1px solid #CBD5E0; border-radius: 0; cursor: pointer; transition: all 0.2s;">Read Manual</button>
                        ${skipHtml}
                    </div>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 20px 40px; background: #F7FAFC; border-top: 1px solid #E2E8F0; font-size: 0.9rem; color: #4A5568; margin-top: auto;">
                    ${controlsHtml}
                </div>
            </div>
        `;

        showModal('Welcome', introHtml);

        // Bind Intro Buttons (Need brief timeout or querySelector inside modal)
        setTimeout(() => {
            const startBtn = document.getElementById('intro-start-btn');
            const manualBtn = document.getElementById('intro-manual-btn');
            const skipCheck = document.getElementById('intro-skip-check');

            if (startBtn) startBtn.addEventListener('click', closeModal);
            if (manualBtn) manualBtn.addEventListener('click', () => {
                // Switch to Manual
                openUserManual();
            });
            if (skipCheck) skipCheck.addEventListener('change', (e) => {
                localStorage.setItem('skipIntro', e.target.checked);
            });
        }, 50);
    }

    // --- HELP BUTTON LOGIC ---
    function openUserManual() {
        // Load external HTML into iframe
        const frameHtml = '<iframe src="UserManual.html" class="modal-frame"></iframe>';
        showModal('User Manual', frameHtml);
    }

    const helpBtn = document.getElementById('helpBtn');
    if (helpBtn) helpBtn.addEventListener('click', openUserManual);


    // gameLoop() will be called at the end of initialization

    const BASE_TILE_WIDTH = 60;
    const BASE_TILE_HEIGHT = 30;
    // Tile dimensions are strictly visual in Pixi container scaling, 
    // but we use these for world coordinate calc.
    let tileWidth = BASE_TILE_WIDTH;
    let tileHeight = BASE_TILE_HEIGHT;

    let startX = 0; // Relative to Viewport (0,0 is fine if we center the grid)
    let startY = 0; // Fix: Reset to 0 to match viewport coordinate system and avoid double-painting offset

    // Helper: Iso to Screen (Global)
    function isoToScreen(gridX, gridY) {
        return {
            x: (gridX - gridY) * tileWidth / 2,
            y: (gridX + gridY) * tileHeight / 2
        };
    }
    // Deprecated legacy screenToIso (Global) - Use viewport.toWorld + Inverse Iso instead.
    function screenToIso(sx, sy) {
        // Only useful if we knew viewport state here, which we don't easily.
        // Keep for legacy generic calls but warn?
        // Or update to use viewport?
        const worldPos = viewport.toWorld(sx, sy);
        const adjX = worldPos.x - startX;
        const adjY = worldPos.y - startY;
        const splitX = adjX / (tileWidth / 2);
        const splitY = adjY / (tileHeight / 2);
        return {
            x: Math.floor((splitY + splitX) / 2),
            y: Math.floor((splitY - splitX) / 2)
        };
    }

    // Viewport Culling: inverse iso transform (world coords → grid coords)
    function screenToGrid(sx, sy) {
        const hW = tileWidth / 2, hH = tileHeight / 2;
        return { x: (sy / hH + sx / hW) / 2, y: (sy / hH - sx / hW) / 2 };
    }

    let lastVisibleRange = null;

    function getVisibleTileRange() {
        try {
            const vb = viewport.getVisibleBounds();
            if (!vb || vb.width === 0 || vb.height === 0)
                return { startX: 0, endX: numCols - 1, startY: 0, endY: numRows - 1 };

            const MAX_OBJ_HEIGHT = tileHeight * 1.5; // buildings extend above tile
            const corners = [
                screenToGrid(vb.x, vb.y - MAX_OBJ_HEIGHT),
                screenToGrid(vb.x + vb.width, vb.y - MAX_OBJ_HEIGHT),
                screenToGrid(vb.x, vb.y + vb.height),
                screenToGrid(vb.x + vb.width, vb.y + vb.height)
            ];

            let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
            for (const c of corners) {
                minGX = Math.min(minGX, c.x); maxGX = Math.max(maxGX, c.x);
                minGY = Math.min(minGY, c.y); maxGY = Math.max(maxGY, c.y);
            }

            const MARGIN = 3;
            return {
                startX: Math.max(0, Math.floor(minGX) - MARGIN),
                endX: Math.min(numCols - 1, Math.ceil(maxGX) + MARGIN),
                startY: Math.max(0, Math.floor(minGY) - MARGIN),
                endY: Math.min(numRows - 1, Math.ceil(maxGY) + MARGIN)
            };
        } catch (e) {
            return { startX: 0, endX: numCols - 1, startY: 0, endY: numRows - 1 };
        }
    }

    // Responsive Canvas
    function resizeCanvas() {
        const container = canvas.parentElement;
        app.renderer.resize(container.clientWidth, container.clientHeight);
        viewport.resize(container.clientWidth, container.clientHeight);

        // Center Grid & Fit to Viewport
        const isoW = (numCols + numRows) * tileWidth;
        const isoH = (numCols + numRows) * tileHeight;

        // Calculate Scale to Fit
        // World Width approx: 2000? No, calculated from Grid.
        // Let's rely on viewport.fit() if possible, but we need world width/height set correctly.
        // Or manual calculation:

        // CSS pixels (app.renderer.width/height are device pixels, which zoomed in too far on high-DPI screens)
        const screenW = app.screen.width;
        const screenH = app.screen.height;

        // Base fit on ISO dimensions
        // Iso Grid is roughly: Width = N * TileWidth, Height = N * TileHeight (Total diagonals)
        // Actually: Width = (Rows + Cols) * TileWidth / 2
        // Height = (Rows + Cols) * TileHeight / 2
        const totalIsoW = (numCols + numRows) * tileWidth / 2;
        const totalIsoH = (numCols + numRows) * tileHeight / 2;

        const margin = 0.9;
        const scaleX = screenW / totalIsoW;
        const scaleY = screenH / totalIsoH;
        let finalScale = Math.min(scaleX, scaleY) * margin;

        // Clamp
        if (finalScale < 0.1) finalScale = 0.1;
        if (finalScale > 2.0) finalScale = 2.0;

        viewport.setZoom(finalScale);
        viewport.moveCenter(0, totalIsoH / 2); // Center of grid in World Space (Top-Center is 0,0, Bottom is 0, H)
    }
    window.addEventListener('resize', () => resizeCanvas());

    const showSlab = true; // Always visible by default

    // Add Event Listeners for Zoom/Pan
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // INTERACTION: Spatial Hashing on Viewport
    viewport.eventMode = 'static';
    viewport.sortableChildren = false; // We use static Z-order (Painter's Algo)

    // ============================================================
    // PixiJS SCENE GRAPH
    // ============================================================
    const worldGrid = new PIXI.Container();
    const uiLayer = new PIXI.Container();
    viewport.addChild(worldGrid);
    viewport.addChild(uiLayer);
    let gridGraphicRefs = []; // 2D array: gridGraphicRefs[y][x] = PIXI.Container

    // CSS color string -> PixiJS hex number
    function cssToHex(color) {
        if (typeof color === 'number') return color;
        if (!color) return 0x000000;
        color = String(color).trim();
        if (color.startsWith('#')) {
            const h = color.slice(1);
            if (h.length === 3) return parseInt(h[0] + h[0] + h[1] + h[1] + h[2] + h[2], 16);
            return parseInt(h.substring(0, 6), 16);
        }
        const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) return (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
        return 0x000000;
    }

    // --- CUSTOM PIXELATE FILTER ---
    // Simple fragment shader to pixelate the viewport
    class PixelateFilter extends PIXI.Filter {
        constructor(size = 10) {
            super(
                null, // Use default vertex shader
                `
                precision mediump float;
                varying vec2 vTextureCoord;
                uniform sampler2D uSampler;
                uniform vec4 filterArea; // xy = dimensions, zw = padding/offsets (provided by Pixi)

                uniform float size;

                void main(void) {
                    vec2 coord = vTextureCoord * filterArea.xy;
                    coord = floor(coord / size) * size;
                    vec2 uv = coord / filterArea.xy;
                    gl_FragColor = texture2D(uSampler, uv);
                }
                `
            );
            this.size = size;
        }

        get size() {
            return this.uniforms.size;
        }

        set size(value) {
            this.uniforms.size = value;
        }
    }

    // Instantiate global filter
    const pixelateFilter = new PixelateFilter(1);





    // Extract alpha from CSS rgba() string (returns 1.0 for hex colors or rgb without alpha)
    function cssAlpha(color) {
        if (typeof color !== 'string') return 1.0;
        const m = color.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/);
        return m ? parseFloat(m[1]) : 1.0;
    }

    // Draw isometric diamond tile on a PIXI.Graphics
    // Optional `scale` param (default 1.0) scales the diamond around its center
    function drawIsoTileG(g, sx, sy, tw, th, fillHex, fillAlpha, strokeHex, strokeAlpha, sq, lw, scale) {
        const s = (scale !== undefined && scale !== null) ? scale : 1.0;
        const hW = tw / 2, hH = th / 2;
        // Center of the diamond: sx, sy + hH
        const cx = sx, cy = sy + hH;
        const u0 = sq.l, u1 = 1 - sq.r, v0 = sq.t, v1 = 1 - sq.b;
        // getS maps (u,v) in [0,1]x[0,1] to screen coords, with scale applied around center
        const gx = (u, v) => cx + (u * hW + v * (-hW)) * s;
        const gy = (u, v) => cy + ((u - 1) * hH + v * hH) * s;
        const pts = [
            gx(u0, v0), gy(u0, v0), gx(u1, v0), gy(u1, v0),
            gx(u1, v1), gy(u1, v1), gx(u0, v1), gy(u0, v1)
        ];
        if (lw > 0 && strokeAlpha > 0) g.lineStyle(lw, strokeHex, strokeAlpha);
        g.beginFill(fillHex, fillAlpha);
        g.drawPolygon(pts);
        g.endFill();
        g.lineStyle(0);
    }

    // Shadow Direction Helper (Global)
    function pixiGetShadowShift(z) {
        const sf = tileHeight / 30;
        const len = z * 0.6 * sf; // Shadow Length (proportional to height z)
        // Down-Right (aligned with Grid X-Axis Strict)
        // Isometric X-Axis is (1, 0.5) exact
        return { x: len, y: len * 0.5 };
    }

    // Sets hoveredCell to the plot (and edge) under the pointer. Returns true when the pointer is on the grid.
    // Also called on pointerdown: a finger has no hover, so without this a tap would act on the previously touched plot.
    function updateHoverFromEvent(e) {
        const worldPos = viewport.toWorld(e.global);

        // Inverse Iso (Screen to Grid)
        // Original: x_screen = (x - y) * w/2, y_screen = (x + y) * h/2
        // x_grid = (y_screen / (h/2) + x_screen / (w/2)) / 2
        // y_grid = (y_screen / (h/2) - x_screen / (w/2)) / 2

        // Adjust for start offsets (we will assume grid starts at 0,0 or handle startX/Y)
        // Let's assume startX = 0, startY = 0 for the viewport contents implies Top-Center of Diamond is at 0,0.
        // We will set viewport center to 0,0 later.

        const adjX = worldPos.x;
        const adjY = worldPos.y;

        const gridY = Math.floor((adjY / (tileHeight / 2) - adjX / (tileWidth / 2)) / 2);
        const gridX = Math.floor((adjY / (tileHeight / 2) + adjX / (tileWidth / 2)) / 2);

        // Update Hover State
        // Update Hover State
        if (gridX >= 0 && gridX < numCols && gridY >= 0 && gridY < numRows) {
            // Calculate sub-tile coordinates (u, v in [0,1])
            // Screen Pos of tile center (at 0,0 local) is isoToScreen(gridX, gridY).
            // But we have worldPos (adjX, adjY). 
            // Reverse mapping: 
            // u = ((adjX / (tileWidth/2)) + (adjY / (tileHeight/2))) / 2 - gridX;
            // v = ((adjY / (tileHeight/2)) - (adjX / (tileWidth/2))) / 2 - gridY;
            // Wait, let's verify algebra.

            // X_grid = (Y_screen/h + X_screen/w) / 2
            // 2 * X_grid = ...
            // Let's use the fraction part of the float grid calculation.

            const rawGridX = (adjY / (tileHeight / 2) + adjX / (tileWidth / 2)) / 2;
            const rawGridY = (adjY / (tileHeight / 2) - adjX / (tileWidth / 2)) / 2;

            const u = rawGridX - gridX; // [0, 1] (actually u is along one axis)
            const v = rawGridY - gridY; // [0, 1]

            // Determine Edge (for Path Tool)
            let edge = null;
            const margin = 0.25;

            // Logic: Which edge is closest?
            // Diamond: u+v (not quite orthogonal in u,v space).
            // In u,v space [0,1]x[0,1], it IS a square.
            // Edges are u=0 (top-left visual?), u=1, v=0, v=1.
            // Let's map visual edges to u,v properties from drawIsoTileG:
            // Points: (u0,v0) is top, (u1,v0) right, (u1,v1) bottom, (u0,v1) left.
            // Wait, drawIsoTileG says:
            // gx = sx + u*hW + v*(-hW)
            // gy = sy + u*hH + v*hH
            // If u varies 0->1 (v constant), x increases, y increases. (Down-Right) -> "Right" visual side?
            // If v varies 0->1 (u constant), x decreases, y increases. (Down-Left) -> "Left" visual side?

            // Let's check `addPaths`:
            // `right` path draws when sq.r is set.
            // `bottom` path sends to neighbor y+1? Or x+1?
            // Let's look at `paintAt` path logic I just wrote:
            // "right" -> plot.paths.right = true.
            // "bottom" -> plot.paths.bottom = true.
            // "left" -> neighbor x-1 right.
            // "top" -> neighbor y-1 bottom.

            // So we need to map u,v to these.
            // u=1 is "Right" edge (increasing X grid?)
            // v=1 is "Bottom" edge (increasing Y grid?)
            // u=0 is "Top"? Or "Left"?
            // v=0 is "Top"? Or "Left"?

            // rawGridX increases as we go Down-Right. (u increases). So u=1 is border with X+1. (Right Neighbor) -> "Right Edge".
            // rawGridY increases as we go Down-Left. (v increases). So v=1 is border with Y+1. (Bottom Neighbor) -> "Bottom Edge".

            // So:
            // u > 1-margin -> Right
            // v > 1-margin -> Bottom
            // u < margin -> Left (Border with X-1)
            // v < margin -> Top (Border with Y-1)

            // Priority? Corners? 
            // Simple distance check.
            const dRight = 1 - u;
            const dBottom = 1 - v;
            const dLeft = u;
            const dTop = v;

            const minD = Math.min(dRight, dBottom, dLeft, dTop);

            if (minD < margin) {
                if (minD === dRight) edge = 'right';
                else if (minD === dBottom) edge = 'bottom';
                else if (minD === dLeft) edge = 'left';
                else if (minD === dTop) edge = 'top';
            }

            hoveredCell = { x: gridX, y: gridY, edge: edge };
            return true;
        }
        hoveredCell = { x: -1, y: -1, edge: null };
        return false;
    }

    viewport.on('pointermove', (e) => {
        if (!updateHoverFromEvent(e)) return;
        const gridX = hoveredCell.x, gridY = hoveredCell.y;

        // Drag preview (Freeze Tool or Shift + Zone Paint)
        if (dragRectStart && currentMode === 'draw') {
            dragRectEnd = { x: gridX, y: gridY };
            requestRender();
        } else if (isPainting && currentMode === 'draw') {
            // Paint Logic
            paintAt(gridX, gridY, e.originalEvent.shiftKey || eraseToolActive);
        }
    });



    // --- INTERACTION STATE ---
    let selectedPlot = null; // {x, y}
    const highlightGraphics = new PIXI.Graphics();
    highlightGraphics.zIndex = 9000; // Topmost
    viewport.addChild(highlightGraphics);

    // Helper: Draw Highlight Outline
    function drawHighlight(g, x, y, color, thickness, alpha = 1.0) {
        // Draw Isometric Diamond Outline
        const sp = isoToScreen(x, y);
        const hw = tileWidth / 2;
        const hh = tileHeight / 2;
        const cx = sp.x;
        const cy = sp.y + hh; // Center

        const pts = [
            cx, cy - hh, // Top
            cx + hw, cy, // Right
            cx, cy + hh, // Bottom
            cx - hw, cy  // Left
        ];

        g.lineStyle(thickness, color, alpha);
        g.drawPolygon(pts);
        g.lineStyle(0);
    }

    function updateHighlights() {
        highlightGraphics.clear();

        // 1. Draw Hover (Black)
        if (hoveredCell && hoveredCell.x !== -1) {
            // Only if not selected (or draw over?)
            const isSelected = selectedPlot && selectedPlot.x === hoveredCell.x && selectedPlot.y === hoveredCell.y;

            if (!isSelected) {
                const plot = dataGrid[hoveredCell.y][hoveredCell.x];
                const isEmpty = plot.name === 'EMPTY' || plot.name === 'SKELETON';
                const thickness = isEmpty ? 1 : 2; // Thin (1) vs Thick (2)
                drawHighlight(highlightGraphics, hoveredCell.x, hoveredCell.y, 0x000000, thickness, 0.8);
            }
        }

        // 2. Draw Selection (White)
        if (selectedPlot) {
            drawHighlight(highlightGraphics, selectedPlot.x, selectedPlot.y, 0xFFFFFF, 2, 1.0);
        }
    }

    viewport.on('pointermove', (e) => {
        // ... (Existing sizing logic) ...
        // We need to trigger highlight update
        updateHighlights();
    });

    // Inspector / Selection Mode: toggle the selection of the plot under the pointer (or deselect when off the grid)
    function selectHoveredPlot() {
        if (hoveredCell && hoveredCell.x >= 0) {
            const cx = hoveredCell.x;
            const cy = hoveredCell.y;

            // Toggle Selection
            if (selectedPlot && selectedPlot.x === cx && selectedPlot.y === cy) {
                // Deselect if clicking same
                selectedPlot = null;
                hideInspector();
            } else {
                selectedPlot = { x: cx, y: cy };
                const plot = dataGrid[cy][cx];
                const zone = zoneGrid[cy][cx];
                showInspector(cx, cy, plot, zone); // Position handled by CSS/Fixed for now
            }
        } else {
            // Clicked void -> Deselect
            selectedPlot = null;
            hideInspector();
        }
        updateHighlights();
    }

    // TOUCH INPUT
    // One finger paints (draw mode) or pans the view (simulation mode); two fingers pan and zoom (pinch).
    // In simulation mode a plot is only selected when a short tap is released, so starting a pan does not select.
    const activeTouches = new Set();
    let touchTap = null;       // { id, x, y } of a possible tap in simulation mode
    const TAP_MAX_MOVE = 10;   // px a finger may move and still count as a tap

    // Note: resuming the drag plugin forgets where the finger went down, so only resume it when it is paused
    function resumeDrag() {
        const drag = viewport.plugins.get('drag');
        if (drag && drag.paused) viewport.plugins.resume('drag');
    }

    function touchDown(e) {
        activeTouches.add(e.pointerId);
        if (activeTouches.size === 1) {
            // In draw mode a single finger paints, so it must not also pan the view
            if (currentMode === 'draw') viewport.plugins.pause('drag');
            else resumeDrag();
        } else {
            // A second finger means pan/zoom: stop the stroke or tap the first finger started
            isPainting = false;
            dragRectStart = null;
            dragRectEnd = null;
            touchTap = null;
            requestRender();
        }
    }

    function touchEnd(e) {
        activeTouches.delete(e.pointerId);
        if (activeTouches.size === 0) resumeDrag();
    }
    viewport.on('pointerupoutside', (e) => {
        if (e.pointerType !== 'touch') return;
        touchEnd(e);
        isPainting = false;
        touchTap = null;
    });
    window.addEventListener('pointercancel', (e) => {
        if (e.pointerType !== 'touch') return;
        touchEnd(e);
        isPainting = false;
        touchTap = null;
    });

    viewport.on('pointerdown', (e) => {
        const isTouch = e.pointerType === 'touch';
        if (isTouch) {
            touchDown(e);
            if (activeTouches.size > 1) return;
        }
        // A finger has no hover: find the plot under it now
        updateHoverFromEvent(e);

        if (isTouch && currentMode !== 'draw') {
            touchTap = { id: e.pointerId, x: e.global.x, y: e.global.y };
            return; // selection happens on release (see pointerup)
        }

        if (e.button === 0 && hoveredCell && hoveredCell.x >= 0) {

            if (currentMode === 'draw') {
                // Rectangle Drag: Freeze Tool OR Shift + Brush (except Path)
                const isPathBrush = currentBrush && currentBrush.name === 'PATH';
                if ((freezeToolActive || (e.originalEvent.shiftKey && !isPathBrush)) && hoveredCell.x >= 0) {
                    dragRectStart = { x: hoveredCell.x, y: hoveredCell.y };
                    dragRectEnd = { x: hoveredCell.x, y: hoveredCell.y };
                    isPainting = false;
                    return;
                }

                // SHIFT + CLICK -> Remove Path (legacy behavior)
                // Enable Drag-Deletion by setting isPainting = true
                if (e.originalEvent.shiftKey && isPathBrush) {
                    isPainting = true;
                    paintAt(hoveredCell.x, hoveredCell.y, true); // Pass true for isShift
                    return;
                }

                isPainting = true;
                paintAt(hoveredCell.x, hoveredCell.y, e.originalEvent.shiftKey || eraseToolActive);
            } else {
                selectHoveredPlot();
            }
        } else if (e.button === 0 && (!hoveredCell || hoveredCell.x === -1)) {
            selectHoveredPlot();
        }
    });

    viewport.on('pointerup', (e) => {
        isPainting = false;

        if (e.pointerType === 'touch') {
            const tap = touchTap;
            touchTap = null;
            const wasSingle = activeTouches.size === 1;
            touchEnd(e);
            // Simulation mode: a short tap (no pan, no second finger) selects the plot
            if (tap && wasSingle && tap.id === e.pointerId && currentMode !== 'draw' &&
                Math.hypot(e.global.x - tap.x, e.global.y - tap.y) <= TAP_MAX_MOVE) {
                updateHoverFromEvent(e);
                selectHoveredPlot();
            }
        }

        // Rectangle Paint / Freeze Tool: apply rectangle selection
        if (dragRectStart && dragRectEnd && currentMode === 'draw') {
            const x0 = Math.min(dragRectStart.x, dragRectEnd.x);
            const x1 = Math.max(dragRectStart.x, dragRectEnd.x);
            const y0 = Math.min(dragRectStart.y, dragRectEnd.y);
            const y1 = Math.max(dragRectStart.y, dragRectEnd.y);
            const isUnfreeze = (e.data && e.data.originalEvent && e.data.originalEvent.shiftKey) || eraseToolActive;
            for (let fy = y0; fy <= y1; fy++) {
                for (let fx = x0; fx <= x1; fx++) {
                    if (fx >= 0 && fx < numCols && fy >= 0 && fy < numRows) {
                        if (freezeToolActive) {
                            freezeGrid[fy][fx] = !isUnfreeze;
                        } else {
                            paintAt(fx, fy, isUnfreeze);
                        }
                    }
                }
            }
            dragRectStart = null;
            dragRectEnd = null;
            invalidateStaticCache();
            drawScene();
        }
    });

    // Inspector UI Logic
    const inspectorCard = document.getElementById('inspector-card');
    const inspectorContent = document.getElementById('inspector-content');
    const closeInspectorBtn = document.getElementById('close-inspector');

    if (closeInspectorBtn) {
        closeInspectorBtn.addEventListener('click', () => {
            hideInspector();
            selectedPlot = null;
            updateHighlights();
        });
    }

    // Auto-close Inspector on outside interaction
    // handled by pointerdown on void

    function showInspector(x, y, plot, zone) {
        if (!inspectorCard) return;
        updateInspectorContent(x, y);
        inspectorCard.style.display = 'block';

        // Position the inspector near the clicked plot
        const worldPos = isoToScreen(x, y);
        const hw = tileWidth / 2;
        const hh = tileHeight / 2;
        // Center of the tile in world space
        const worldCenterX = worldPos.x;
        const worldCenterY = worldPos.y + hh;

        // Convert world to screen using viewport transform
        const scale = viewport.scale.x;
        const screenX = worldCenterX * scale + viewport.x;
        const screenY = worldCenterY * scale + viewport.y;

        // Get the canvas bounding rect to offset properly
        const rect = app.view.getBoundingClientRect();
        const absX = rect.left + screenX;
        const absY = rect.top + screenY;

        // Position to the right of the tile, with some offset
        const cardWidth = 280;
        const cardHeight = inspectorCard.offsetHeight || 250;
        let posX = absX + hw * scale + 10; // Right of tile
        let posY = absY - cardHeight / 2;  // Vertically centered on tile

        // Clamp to viewport bounds
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        // If it would go off the right edge, put it to the left of the tile
        if (posX + cardWidth > viewW - 10) {
            posX = absX - hw * scale - cardWidth - 10;
        }
        // Clamp vertical
        if (posY < 10) posY = 10;
        if (posY + cardHeight > viewH - 10) posY = viewH - cardHeight - 10;

        inspectorCard.style.top = posY + 'px';
        inspectorCard.style.left = posX + 'px';
        inspectorCard.style.right = 'auto';
    }

    let activeInspectorPlot = null; // Track open inspector

    function hideInspector() {
        if (inspectorCard) inspectorCard.style.display = 'none';
        activeInspectorPlot = null;
    }

    function updateInspectorContent(x, y) {
        if (!inspectorContent) return;

        // Safety check if grid changed
        if (y < 0 || y >= numRows || x < 0 || x >= numCols) {
            hideInspector();
            return;
        }

        const plot = dataGrid[y][x];
        const zone = zoneGrid[y][x];

        // Format Values
        const typeColor = plot.name === 'SPORT' ? 'color:#2F80ED' : (plot.name === 'FARMING' ? 'color:#D69E2E' : (plot.name === 'GREEN' ? 'color:#27AE60' : (plot.name === 'WORKSHOP' ? 'color:#8B6914' : 'color:black')));
        const suitability = (plot.value && plot.value > 0) ? plot.value.toFixed(2) : '-';
        const age = (plot.age || 0).toFixed(1) + ' YRS';
        const condition = 'GOOD'; // Placeholder logic
        const conditionClass = 'val-good';

        // Compute adjacent green count dynamically
        let adjGreen = 0;
        const neighborOffsets = [
            { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }
        ];
        for (const off of neighborOffsets) {
            const nx = x + off.dx;
            const ny = y + off.dy;
            if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                if (dataGrid[ny][nx].name === 'GREEN') adjGreen++;
            }
        }

        // Compute tree donation status dynamically
        let treeDonationText = '-';
        let donationClass = '';
        if (plot.name !== 'EMPTY' && plot.name !== 'EXISTING' && plot.name !== 'GREEN' &&
            zone.name !== 'SKELETON' && zone.name !== 'EXISTING_HOUSING' && zone.name !== 'AQUEDUCT') {
            if (simulationRules.treeDonation) {
                const greenNeighbor = findNearestGreenNeighbor(x, y);
                if (greenNeighbor) {
                    treeDonationText = 'DONATED 1';
                    donationClass = 'val-blue';
                } else {
                    treeDonationText = 'NO TARGET';
                }
            } else {
                treeDonationText = '-';
            }
        } else if (plot.name === 'GREEN') {
            // Green plots receive donations - count how many neighbors donated to this plot
            let received = 0;
            // Check all 8 neighbors (same as findNearestGreenNeighbor uses)
            const allOffsets = [
                { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
                { dx: 1, dy: -1 }, { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 }
            ];
            if (simulationRules.treeDonation) {
                for (const off of allOffsets) {
                    const nx = x + off.dx;
                    const ny = y + off.dy;
                    if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                        const np = dataGrid[ny][nx];
                        const nz = zoneGrid[ny][nx];
                        // This neighbor would donate if it's a non-empty building plot
                        // AND this green plot is its nearest green neighbor
                        if (np.name !== 'EMPTY' && np.name !== 'EXISTING' && np.name !== 'GREEN' &&
                            nz.name !== 'SKELETON' && nz.name !== 'EXISTING_HOUSING' && nz.name !== 'AQUEDUCT') {
                            const target = findNearestGreenNeighbor(nx, ny);
                            if (target === plot) received++;
                        }
                    }
                }
            }
            if (received > 0) {
                treeDonationText = `RECEIVED ${received}`;
                donationClass = 'val-blue';
            }
        }

        // Compute area - check if plot has paths or is adjacent to roads
        let areaText = 'FULL TILE';
        const hasPathOnPlot = plot.paths && (plot.paths.left || plot.paths.right || plot.paths.top || plot.paths.bottom);
        const adjToRoad = isRoad(x - 1, y) || isRoad(x + 1, y) || isRoad(x, y - 1) || isRoad(x, y + 1);
        if (hasPathOnPlot || adjToRoad) {
            areaText = 'FULL TILE'; // Still full tile but has road/path adjacency
        }

        // Generate Content
        let html = '';

        // Section 1: Info
        html += `<div class="inspector-row"><span class="inspector-label">Type</span><span class="inspector-value" style="${typeColor}">${plot.name}</span></div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Zone</span><span class="inspector-value">${zone.name}</span></div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Grid Pos</span><span class="inspector-value">(${x}, ${y})</span></div>`;

        const mergedStatus = plot.mergedWith ? "Yes" : "No";
        html += `<div class="inspector-row"><span class="inspector-label">Merged</span><span class="inspector-value">${mergedStatus}</span></div>`;

        let paths = [];
        // Top (North) -> y-1 bottom
        if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) paths.push("N");
        // Right (East) -> plot.paths.right
        if (plot.paths && plot.paths.right) paths.push("E");
        // Bottom (South) -> plot.paths.bottom
        if (plot.paths && plot.paths.bottom) paths.push("S");
        // Left (West) -> x-1 right
        if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) paths.push("W");
        const pathString = paths.length > 0 ? paths.join(", ") : "None";
        html += `<div class="inspector-row"><span class="inspector-label">Paths</span><span class="inspector-value">${pathString}</span></div>`;

        html += `<div class="inspector-row"><span class="inspector-label">Suitability</span><span class="inspector-value">${suitability}</span></div>`;

        html += `<div class="inspector-separator"></div>`;

        // Section 2: Status
        html += `<div class="inspector-row"><span class="inspector-label">Age</span><span class="inspector-value">${age}</span></div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Condition</span><span class="inspector-value ${conditionClass}">${condition}</span></div>`;

        html += `<div class="inspector-separator"></div>`;

        // Section 3: Influences
        html += `<div class="inspector-section-title">Influences</div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Area</span><span class="inspector-value">${areaText}</span></div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Adj. Green</span><span class="inspector-value">${adjGreen}</span></div>`;
        html += `<div class="inspector-row"><span class="inspector-label">Tree Donation</span><span class="inspector-value ${donationClass}">${treeDonationText}</span></div>`;

        inspectorContent.innerHTML = html;
    }



    window.addEventListener('mouseup', () => {
        viewState.isDragging = false;
        isPainting = false; // Fix: Stop painting on global mouse up
        canvas.style.cursor = 'default';

        // Resume Simulation on Pan End (if it was paused by interaction)
        if (wasPausedByInteraction) {
            startSimulation();
            wasPausedByInteraction = false;
            // Status will be updated by startSimulation() or the next tick
        }
    });

    // Interaction state: suppress shadows during zoom/pan for performance
    let isInteracting = false;
    let interactionTimer = null;
    function markInteracting() {
        isInteracting = true;
        clearTimeout(interactionTimer);
        interactionTimer = setTimeout(() => {
            isInteracting = false;
            requestRender(); // Clean rebuild with shadows once settled
        }, 200);
    }

    canvas.addEventListener('mousemove', (e) => {
        if (viewState.isDragging) {
            markInteracting();
            // Viewport handles panning automatically via 'drag' plugin.
            // We just need to handle interaction state / pause.

            // Pause Logic
            if (simulationInterval) {
                pauseSimulation();
                wasPausedByInteraction = true;
                const statusEl = document.getElementById('sim-status-text');
                if (statusEl) statusEl.textContent = 'PAUSED II';
            }

            viewState.lastMouseX = e.clientX;
            viewState.lastMouseY = e.clientY;

            // REMOVED: invalidateStaticCache() and requestRender() were causing
            // 60fps rebuilds during pan. Viewport's drag plugin handles the visual
            // transform; culling hysteresis triggers rebuilds when new tiles are needed.
        }

        // GENERAL HOVER UPDATE
        const rect = canvas.getBoundingClientRect();
        // Viewport toWorld handles CSS scaling if resolution matches?
        // viewport.toWorld takes GLOBAL (screen) coords if interaction manager is set up?
        // No, interaction manager handles it.
        // We probably need to pass clientX/Y relative to canvas?
        // viewport.toWorld(point) expects local point in parent container? No, global.

        // Correct way with Pixi Viewport:
        const worldPos = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);

        // Grid Conversion (Inverse Iso)
        // We use worldPos directly. startX/startY are ignored in isoToScreen, so we ignore them here too.
        // If isoToScreen (0,0) -> 0,0, then world 0,0 is grid 0,0.
        const adjX = worldPos.x;
        const adjY = worldPos.y;

        const gridY = Math.floor((adjY / (tileHeight / 2) - adjX / (tileWidth / 2)) / 2);
        const gridX = Math.floor((adjY / (tileHeight / 2) + adjX / (tileWidth / 2)) / 2);

        let newHoveredCell = null;
        if (gridX >= 0 && gridX < numCols && gridY >= 0 && gridY < numRows) {
            newHoveredCell = { x: gridX, y: gridY };
            if (activeTab === 'grid' && currentMode === 'draw' && currentBrush && currentBrush.name === 'PATH') {
                // Tooltip or Edge logic...
                // Need mouseX relative to Tile?
                // Simple approximation for now or reuse legacy logic with world transformed coords?
                // Legacy getHoveredEdge used screenX/Y vs isoToScreen...
                // We can pass worldPos?
                // Let's skip edge logic refinement for now unless broken.
            }
        }

        // Update Hover
        if (!hoveredCell && newHoveredCell) {
            hoveredCell = newHoveredCell;
            requestRender();
        } else if (hoveredCell && !newHoveredCell) {
            hoveredCell = null;
            requestRender();
        } else if (hoveredCell && newHoveredCell) {
            if (hoveredCell.x !== newHoveredCell.x || hoveredCell.y !== newHoveredCell.y) {
                hoveredCell = newHoveredCell;
                requestRender();
            }
        }


    });

    // REMOVED MANUAL WHEEL LISTENER - Using viewport.wheel() instead
    /*
    canvas.addEventListener('wheel', (e) => {
        // ... (Manual logic removed)
    }, { passive: false });
    */
    const sliders = {
        tickSpeed: document.getElementById('tickSpeed'),
        greenSpawnRate: document.getElementById('greenSpawnRate'),
        farmingSpawnRate: document.getElementById('farmingSpawnRate'),
        sportSpawnRate: document.getElementById('sportSpawnRate'),
        workshopSpawnRate: document.getElementById('workshopSpawnRate'),
        zoneInfluence: document.getElementById('zoneInfluence'),
        synergyBonus: document.getElementById('synergyBonus'),
        decayChance: document.getElementById('decayChance'),
        reEvaluationAge: document.getElementById('reEvaluationAge'),
        farmingMergeAge: document.getElementById('farmingMergeAge'),
        farmingMergeChance: document.getElementById('farmingMergeChance'),
        workshopMergeChance: document.getElementById('farmingMergeChance'), // Reuse same slider for Workshop
        doorChance: document.getElementById('doorChance'),
        toppingChance: document.getElementById('toppingChance'),
        roadBonus: document.getElementById('roadBonus'),
        baseScoreGreen: document.getElementById('baseScoreGreen'),
        baseScoreFarming: document.getElementById('baseScoreFarming'),
        baseScoreSport: document.getElementById('baseScoreSport'),
        baseScoreWorkshop: document.getElementById('baseScoreWorkshop'),

    };
    const sliderValues = {
        tickSpeedValue: document.getElementById('tickSpeedValue'),
        greenSpawnRateValue: document.getElementById('greenSpawnRateValue'),
        farmingSpawnRateValue: document.getElementById('farmingSpawnRateValue'),
        sportSpawnRateValue: document.getElementById('sportSpawnRateValue'),
        workshopSpawnRateValue: document.getElementById('workshopSpawnRateValue'),
        zoneInfluenceValue: document.getElementById('zoneInfluenceValue'),
        synergyBonusValue: document.getElementById('synergyBonusValue'),
        decayChanceValue: document.getElementById('decayChanceValue'),
        reEvaluationAgeValue: document.getElementById('reEvaluationAgeValue'),
        reEvaluationAgeValue: document.getElementById('reEvaluationAgeValue'),
        farmingMergeAgeValue: document.getElementById('farmingMergeAgeValue'),
        farmingMergeChanceValue: document.getElementById('farmingMergeChanceValue'),
        doorChanceValue: document.getElementById('doorChanceValue'),
        toppingChanceValue: document.getElementById('toppingChanceValue'),
        roadBonusValue: document.getElementById('roadBonusValue'),
        baseScoreGreenValue: document.getElementById('baseScoreGreenValue'),
        baseScoreFarmingValue: document.getElementById('baseScoreFarmingValue'),
        baseScoreSportValue: document.getElementById('baseScoreSportValue'),
        baseScoreWorkshopValue: document.getElementById('baseScoreWorkshopValue'),

    };
    const paletteContainer = document.getElementById('palette');
    const modeBtn = document.getElementById('mode-toggle');
    const startBtn = document.getElementById('start-sim');
    const pauseBtn = document.getElementById('pause-sim');
    const resetBtn = document.getElementById('reset-sim');
    const dateDisplay = document.getElementById('date-display');
    const progressBar = document.getElementById('year-progress-bar');


    // FLOATING TOOLTIP LOGIC
    const tooltip = document.getElementById('floating-tooltip');
    // Touch: there is no hover, so the info text is docked at the bottom of the screen (CSS body.touch) and
    // disappears by itself after a few seconds instead of on mouseleave.
    const TOUCH_INFO_MS = 4000;
    let touchInfoTimer = null;
    function updateInfoBox(text) {
        if (!tooltip) return;
        if (IS_TOUCH) {
            if (!text) return;
            tooltip.textContent = text;
            tooltip.style.display = '';
            tooltip.classList.add('visible');
            clearTimeout(touchInfoTimer);
            touchInfoTimer = setTimeout(() => tooltip.classList.remove('visible'), TOUCH_INFO_MS);
            return;
        }
        // If text is empty or null, hide
        if (!text || text === "") {
            tooltip.classList.remove('visible');
            tooltip.style.display = ''; // Clear inline style (clean up)
        } else {
            tooltip.textContent = text;
            tooltip.style.display = ''; // Remove 'none' if set by graph
            tooltip.classList.add('visible');
        }
    }

    // Track mouse for tooltip positioning
    document.addEventListener('mousemove', (e) => {
        if (IS_TOUCH) return; // docked
        if (tooltip && tooltip.classList.contains('visible')) {
            // dynamic positioning
            let x = e.clientX + 15;
            let y = e.clientY + 15;

            // Simple viewport bounds check to prevent overflow
            if (x + 200 > window.innerWidth) x = e.clientX - 215; // Flip left
            if (y + 50 > window.innerHeight) y = e.clientY - 50;  // Flip up

            tooltip.style.left = `${x}px`;
            tooltip.style.top = `${y}px`;
        }
    });
    const statDisplays = {
        GREEN: document.getElementById('green-percentage'),
        FARMING: document.getElementById('farming-percentage'),
        SPORT: document.getElementById('sport-percentage'),
        WORKSHOP: document.getElementById('workshop-percentage'),
        EMPTY: document.getElementById('empty-percentage'),
    };
    // Reset View Button Definition
    const resetViewBtn = document.getElementById('resetViewBtn');
    if (resetViewBtn) {
        resetViewBtn.addEventListener('click', () => {
            // Reset legacy state to defaults
            viewState.zoom = 1.0;
            viewState.panX = 0;
            viewState.panY = 0;
            viewState.isDragging = false;
            tileWidth = BASE_TILE_WIDTH;
            tileHeight = BASE_TILE_HEIGHT;

            // Use new Responsive Logic to fit grid
            resizeCanvas();
        });
    }

    resizeCanvas(true);


    // Settings Menu Logic
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsMenu = document.getElementById('settingsMenu');
    if (settingsBtn && settingsMenu) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent document click from closing it immediately
            settingsMenu.classList.toggle('visible');
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (settingsMenu.classList.contains('visible')) {
                if (!settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
                    settingsMenu.classList.remove('visible');
                }
            }
        });
    }

    const toggleHeatmapBtn = document.getElementById('toggleHeatmapBtn');
    const toggleShadowsBtn = document.getElementById('toggleShadowsBtn');
    const togglePixelBtn = document.getElementById('togglePixelBtn');

    let showScores = false;
    let visualizeScores = false;
    const storedShadows = localStorage.getItem('showShadows');
    let showShadows = storedShadows === 'false' ? false : true;

    // Pixel Mode State
    let pixelMode = false;
    let persistentPixelCanvas = null; // OPTIMIZATION: Persistent Offscreen Canvas
    let pixelExponent = 0.45; // Default "Detail Factor"
    let pixelFactor = 6; // 1 screen pixel = 6 physical pixels (Base for dynamic scaling)

    // OPTIMIZATION: Static Render Cache
    let staticCanvas = document.createElement('canvas'); // Offscreen canvas for static elements
    let staticCtx = staticCanvas.getContext('2d');
    let isStaticDirty = true; // Flag to indicate if static cache needs update

    function invalidateStaticCache() {
        isStaticDirty = true;
        layoutsDirty = true; // Recompute sport/workshop layouts on next buildWorld
        worldDirty = true; // PixiJS: mark for rebuild on next frame
        fullRebuildNeeded = true;
    }

    // Initialize UI State
    if (toggleScoresBtn) {
        toggleScoresBtn.dataset.active = showScores;
        if (showScores) toggleScoresBtn.classList.add('active');
        toggleScoresBtn.addEventListener('click', () => {
            showScores = !showScores;
            toggleScoresBtn.dataset.active = showScores;
            toggleScoresBtn.classList.toggle('active', showScores);
            invalidateStaticCache(); // Invalidate on toggle
            requestRender();
        });
        toggleScoresBtn.addEventListener('mouseenter', () => updateInfoBox(toggleScoresBtn.title));
        toggleScoresBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }

    if (toggleHeatmapBtn) {
        toggleHeatmapBtn.dataset.active = visualizeScores;
        if (visualizeScores) toggleHeatmapBtn.classList.add('active');
        toggleHeatmapBtn.addEventListener('click', () => {
            visualizeScores = !visualizeScores;
            toggleHeatmapBtn.dataset.active = visualizeScores;
            toggleHeatmapBtn.classList.toggle('active', visualizeScores);
            invalidateStaticCache(); // Invalidate on toggle
            requestRender();
        });
        toggleHeatmapBtn.addEventListener('mouseenter', () => updateInfoBox(toggleHeatmapBtn.title));
        toggleHeatmapBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }

    if (toggleShadowsBtn) {
        toggleShadowsBtn.dataset.active = showShadows;
        toggleShadowsBtn.classList.toggle('active', showShadows);
        toggleShadowsBtn.addEventListener('click', () => {
            showShadows = !showShadows;
            toggleShadowsBtn.dataset.active = showShadows;
            toggleShadowsBtn.classList.toggle('active', showShadows);
            localStorage.setItem('showShadows', showShadows);
            invalidateStaticCache(); // Invalidate on toggle
            requestRender();
        });
        toggleShadowsBtn.addEventListener('mouseenter', () => updateInfoBox(toggleShadowsBtn.title));
        toggleShadowsBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }

    if (togglePixelBtn) {
        togglePixelBtn.dataset.active = pixelMode;
        if (pixelMode) togglePixelBtn.classList.add('active');
        togglePixelBtn.addEventListener('click', () => {
            pixelMode = !pixelMode;
            togglePixelBtn.dataset.active = pixelMode;
            togglePixelBtn.classList.toggle('active', pixelMode);

            if (pixelMode) {
                // Apply Pixelate Filter
                // Default size based on exponent or factor
                pixelateFilter.size = Math.max(2, pixelExponent * 10);
                app.stage.filters = [pixelateFilter];
                canvas.style.imageRendering = 'pixelated';
            } else {
                app.stage.filters = null;
                canvas.style.imageRendering = 'auto';
            }

            requestRender();
        });
        togglePixelBtn.addEventListener('mouseenter', () => updateInfoBox(togglePixelBtn.title));
        togglePixelBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }

    // PIXEL EXPONENT SETTING
    const pixelExponentInput = document.getElementById('pixelExponentInput');
    if (pixelExponentInput) {
        pixelExponentInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) {
                pixelExponent = val;
                // Update Pixel Mode if active
                if (pixelMode) { // Note: 'pixelMode' vs 'isPixelMode' variable mixup in previous code? 
                    // Let's use the one established at the top (isPixelMode in 'togglePixelBtn' scope or global 'pixelMode' ref?)
                    // The togglePixelBtn block above uses 'isPixelMode' in its closure.
                    // THIS block uses 'pixelMode' which was defined near line 903. 
                    // We should unify these or use the filtered check.

                    // Actually, 'pixelMode' at 903 is the one we should likely use globally.
                    // But 'togglePixelBtn' at line 410 was using a local 'let isPixelMode'.
                    // I will fix the listener to check if filters are active.
                }

                // Better Check:
                if (app.stage.filters && app.stage.filters.includes(pixelateFilter)) {
                    const validScale = viewport.scale.x || 1;
                    // Logic: If user wants CONSISTENT pixel size on screen, 'size' should be constant.
                    // If user wants pixels to stick to world (zoom in = big pixels), 'size' grows with zoom.
                    // User said "pixel factor is changing zoom".
                    // Let's make 'pixelExponentInput' control the Fixed Pixel Size directly?
                    // No, 'pixelFactor' is likely the size. 'Exponent' was for dynamic scaling.

                    // Let's map 'pixelExponent' input directly to Filter Size for simplicity as requested?
                    // "change the factor with the settings"
                    // The input ID is 'pixelExponentInput' but label might be Factor.
                    // Let's assume 'pixelExponent' variable holds the slider value.

                    // SIMPLE MAPPING: Slider Value -> Pixel Size
                    // If slider is 0.1 to 1.0... or 1 to 10?
                    // Let's use 'pixelExponent' as a multiplier or direct size.
                    // Default implementation:
                    pixelateFilter.size = Math.max(2, pixelExponent * 10); // Scale up for visibility
                }
                requestRender();
            }
        });
    }
    let showObjects = true; // Default: Objects Visible

    if (toggleObjectsBtn) {
        const toggleObjectsBtn = document.getElementById('toggleObjectsBtn');
        if (toggleObjectsBtn) {
            toggleObjectsBtn.dataset.active = showObjects;
            toggleObjectsBtn.classList.toggle('active', showObjects);
            toggleObjectsBtn.addEventListener('click', () => {
                showObjects = !showObjects;
                toggleObjectsBtn.dataset.active = showObjects;
                toggleObjectsBtn.classList.toggle('active', showObjects);
                invalidateStaticCache(); // Invalidate on toggle
                requestRender();
            });
            toggleObjectsBtn.addEventListener('mouseenter', () => updateInfoBox(toggleObjectsBtn.title));
            toggleObjectsBtn.addEventListener('mouseleave', () => updateInfoBox(""));
        }
    }

    let simulationParameters = {
        tickSpeed: 2000,
        greenSpawnRate: 0.01, farmingSpawnRate: 0.01, sportSpawnRate: 0.01, workshopSpawnRate: 0.01,
        zoneInfluence: 0.20,
        synergyBonus: 0.10, roadBonus: 0.1,
        reEvaluationAge: 10, changeChance: 0.10, decayChance: 0.03, // 10-year lease cycle (rulebook 0.5)
        farmingMergeAge: 5, farmingMergeChance: 0.01,
        doorChance: 0.25,
        toppingChance: 0.01,
        workshopMergeAge: 5, workshopMergeChance: 0.01,
        greenMergeAge: 5, greenMergeChance: 0.01,
        baseScoreGreen: 1.0, baseScoreFarming: 1.0, baseScoreSport: 1.0, baseScoreWorkshop: 1.0
    };

    let simulationRules = {
        workshopRoadBonus: true,
        workshopDistance: true,
        buildingRoadConstraint: true,
        sportDistance: true,
        farmingNeighbor: true,
        aqueductGreenOnly: true,
        treeDonation: true,
        doorCreation: true,
        toppingRule: true, // Existing
        greenZoneCompliance: true, // New Rule
        allowMerging: true,
        greenLung: true // Rulebook 1.03: 60% of the village surface must remain unpaved
    };

    const plotTypes = {
        EMPTY: { value: 0, color: '#FFFFFF', name: 'EMPTY' },
        GREEN: { value: 1.5, color: '#95D5B2', name: 'GREEN' }, // Original Vibrant Green
        FARMING: { value: 1.3, color: '#D6CAB2', name: 'FARMING' }, // Original Vibrant Beige
        SPORT: { value: 1.2, color: '#A0CED9', name: 'SPORT' }, // Original Vibrant Blue
        WORKSHOP: { value: 1, color: '#FFCB77', name: 'WORKSHOP' }, // Original Vibrant Orange
        EXISTING: { value: 0, color: '#FFFFFF', name: 'EXISTING' }, // White
        REMOVED: { value: 0, color: 'transparent', name: 'REMOVED' } // Missing tile
    };
    const zoneTypes = {
        NEUTRAL: { name: 'NEUTRAL', color: 'rgba(240, 240, 240, 0.3)', description: 'Neutral Zone: Mixed-use potential with no specific typology bias.' },
        GREEN: { name: 'GREEN', color: 'rgba(149, 213, 178, 0.4)', description: 'Green Zone: Designated for parks, ecological corridors, and recreation.' },
        SPORT: { name: 'SPORT', color: 'rgba(160, 206, 217, 0.4)', description: 'Sports Zone: Cluster zoning for athletic facilities and active use.' },
        WORKSHOP: { name: 'WORKSHOP', color: 'rgba(255, 203, 119, 0.4)', description: 'Industrial Zone: Designated for workshops and light manufacturing.' },
        FARMING: { name: 'FARMING', color: 'rgba(214, 202, 178, 0.4)', description: 'Agricultural Zone: Dedicated to extensive farming and food production.' },
        SKELETON: { name: 'SKELETON', color: '#CBD5E0', description: 'Infrastructure: Main arterial roads and utility corridors.' },
        AQUEDUCT: { name: 'AQUEDUCT', color: 'rgba(255, 230, 109, 0.5)', description: 'Water Infrastructure: Aqueducts and water management systems.' },
        EXISTING_HOUSING: { name: 'EXISTING_HOUSING', color: 'rgba(200, 200, 200, 0.6)', description: 'Existing Context: Protected historical housing stock (Unmodifiable).' },
        NONE: { name: 'NONE', color: 'rgba(113, 128, 150, 0.5)', description: 'Excluded Zone: Plots stay empty and do not participate in simulation.' }
    };

    const gridLineColor = 'rgba(0, 0, 0, 0.15)';
    let dataGrid = [], zoneGrid = [], bufferGrid = []; // Added bufferGrid for double buffering
    let currentMode = 'draw', currentBrush = zoneTypes.GREEN, isPainting = false;
    // Freeze Tool state
    let freezeToolActive = false;
    let eraseToolActive = false; // Erase toggle (touch replacement for SHIFT): zones -> erase, path/plot -> remove, freeze -> unfreeze
    let dragRectStart = null;  // {x, y} grid coords — drag start
    let dragRectEnd = null;     // {x, y} grid coords — drag end
    let freezeGrid = [];        // 2D boolean array, same size as dataGrid
    let simulationInterval = null, tickProgress = 0;
    let cumulativeTrees = 0; // NEW: Track total trees planted history
    let simulationHasRun = false; // Track if simulation has ever started (for existing buildings visibility)


    let historyLog = []; // Stores {year, GREEN, FARMING, SPORT, WORKSHOP, EMPTY} stats
    let activeTab = 'grid'; // 'grid' or 'graph'

    // Background image variables
    let backgroundImage = null;
    let imageSettings = {
        opacity: 0.5,
        offsetX: 0,
        offsetY: 0,
        scaleX: 1.0,
        scaleY: 1.0
    };

    // --- REFERENCE IMAGE LOGIC ---
    const imageUpload = document.getElementById('imageUpload');
    const imageOpacity = document.getElementById('imageOpacity');
    const imageOffsetX = document.getElementById('imageOffsetX');
    const imageOffsetY = document.getElementById('imageOffsetY');
    const imageScaleX = document.getElementById('imageScaleX');
    const imageScaleY = document.getElementById('imageScaleY');

    // Values Display Elements
    const imageOpacityValue = document.getElementById('imageOpacityValue');
    const imageOffsetXValue = document.getElementById('imageOffsetXValue');
    const imageOffsetYValue = document.getElementById('imageOffsetYValue');
    const imageScaleXValue = document.getElementById('imageScaleXValue');
    const imageScaleYValue = document.getElementById('imageScaleYValue');

    function updateBackgroundImage() {
        if (!backgroundImage) return;

        // Apply Opacity
        backgroundImage.alpha = imageSettings.opacity;

        // Apply Position (Relative to Center)
        // Center of map is roughly 0,0 in viewport if we center it.
        // Let's assume user wants offset from (0,0) or center of initial view.
        // We will start at (0,0) world coordinates.
        backgroundImage.position.set(imageSettings.offsetX * 10, imageSettings.offsetY * 10); // Scale up movement for usability

        // Apply Scale
        backgroundImage.scale.set(imageSettings.scaleX, imageSettings.scaleY);

        requestRender();
    }

    if (imageUpload) {
        imageUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const dataUrl = event.target.result;
                const texture = PIXI.Texture.from(dataUrl);

                if (backgroundImage) {
                    viewport.removeChild(backgroundImage);
                    backgroundImage.destroy();
                }

                backgroundImage = new PIXI.Sprite(texture);
                backgroundImage.anchor.set(0.5); // Center anchor for easier scaling/positioning
                backgroundImage.eventMode = 'none'; // Pass-through interaction

                // Add to viewport at END (Top)
                viewport.addChild(backgroundImage);

                // Reset settings slightly? Or keep?
                // Keep imageSettings.
                updateBackgroundImage();
            };
            reader.readAsDataURL(file);
        });
    }

    // Helper to bind slider
    const bindImageSlider = (input, display, key, parseFunc = parseFloat, scale = 1) => {
        if (!input) return;
        input.addEventListener('input', (e) => {
            const val = parseFunc(e.target.value);
            // Update Settings
            // Special handling for percentage/scale
            if (key === 'opacity') imageSettings[key] = val / 100;
            else if (key === 'scaleX' || key === 'scaleY') imageSettings[key] = val / 100;
            else imageSettings[key] = val;

            // Update Display
            if (display) {
                if (key === 'opacity') display.textContent = (val / 100).toFixed(2);
                else if (key.startsWith('scale')) display.textContent = (val / 100).toFixed(2);
                else display.textContent = val;
            }

            updateBackgroundImage();
        });
    };

    bindImageSlider(imageOpacity, imageOpacityValue, 'opacity');
    bindImageSlider(imageOffsetX, imageOffsetXValue, 'offsetX');
    bindImageSlider(imageOffsetY, imageOffsetYValue, 'offsetY');
    bindImageSlider(imageScaleX, imageScaleXValue, 'scaleX');
    bindImageSlider(imageScaleY, imageScaleYValue, 'scaleY');

    // --- SIMULATION PARAMETER SLIDERS (Added Fix) ---
    // iterating over the 'sliders' object defined at the top
    Object.keys(sliders).forEach(key => {
        const input = sliders[key];
        // The display spans are in 'sliderValues' with 'Value' suffix
        const display = sliderValues[key + 'Value'];

        if (input) {
            const isPercent = key.includes('SpawnRate') || key.includes('MergeChance') || key.includes('doorChance') || key.includes('toppingChance') || key === 'zoneInfluence' || key === 'synergyBonus' || key === 'roadBonus' || key === 'decayChance' || key === 'changeChance';

            // Initialize from current parameters
            if (simulationParameters[key] !== undefined) {
                let displayVal = simulationParameters[key];
                if (isPercent) {
                    input.value = simulationParameters[key] * 100;
                    displayVal = Math.round(simulationParameters[key] * 100);
                } else {
                    input.value = simulationParameters[key];
                }

                if (display) {
                    if (isPercent) {
                        display.textContent = displayVal + '%';
                    } else if (key.includes('baseScore')) {
                        display.textContent = displayVal.toFixed(1);
                    } else {
                        display.textContent = displayVal;
                    }
                }
            }

            // Bind Event
            input.addEventListener('input', (e) => {
                let val = parseFloat(e.target.value);
                let displayVal = val;

                if (isPercent) {
                    simulationParameters[key] = val / 100;
                } else {
                    simulationParameters[key] = val;
                }

                if (display) {
                    if (isPercent) {
                        display.textContent = displayVal + '%';
                    } else if (key.includes('baseScore')) {
                        display.textContent = displayVal.toFixed(1);
                    } else {
                        display.textContent = displayVal;
                    }
                }

                // SPECIAL HANDLING: Linked Merge Chances
                if (key === 'farmingMergeChance') {
                    simulationParameters.greenMergeChance = simulationParameters.farmingMergeChance;
                    simulationParameters.workshopMergeChance = simulationParameters.farmingMergeChance;
                }
            });
        }
    });

    // Isometric Projection Tools
    // (isoToScreen is defined globally at top of file)



    const getHoveredEdge = (x, y, mouseX, mouseY) => {
        const screenPos = isoToScreen(x, y);
        const cx = screenPos.x;
        const cy = screenPos.y + tileHeight / 2;

        const threshold = tileWidth * 0.25;

        // 1. Current Tile Edges (Right and Bottom)
        // Right Edge (x+1): Midpoint (u=1, v=0.5) -> cx + w/4, cy + h/4
        const rightEdgeX = cx + tileWidth / 4;
        const rightEdgeY = cy + tileHeight / 4;

        // Bottom Edge (y+1): Midpoint (u=0.5, v=1) -> cx - w/4, cy + h/4
        const bottomEdgeX = cx - tileWidth / 4;
        const bottomEdgeY = cy + tileHeight / 4;

        // 2. Neighbor Edges (Top and Left) being hovered
        // Left Edge (x-1): Midpoint (u=0, v=0.5) -> cx - w/4, cy - h/4
        const leftEdgeX = cx - tileWidth / 4;
        const leftEdgeY = cy - tileHeight / 4;

        // Top Edge (y-1): Midpoint (u=0.5, v=0) -> cx + w/4, cy - h/4
        const topEdgeX = cx + tileWidth / 4;
        const topEdgeY = cy - tileHeight / 4;

        const distRight = Math.hypot(mouseX - rightEdgeX, mouseY - rightEdgeY);
        const distBottom = Math.hypot(mouseX - bottomEdgeX, mouseY - bottomEdgeY);
        const distLeft = Math.hypot(mouseX - leftEdgeX, mouseY - leftEdgeY);
        const distTop = Math.hypot(mouseX - topEdgeX, mouseY - topEdgeY);

        let best = { dist: threshold, res: null };

        if (distRight < best.dist) best = { dist: distRight, res: { x: x, y: y, edge: 'right' } };
        if (distBottom < best.dist) best = { dist: distBottom, res: { x: x, y: y, edge: 'bottom' } };

        // Map Top/Left to neighbors
        if (distLeft < best.dist) best = { dist: distLeft, res: { x: x - 1, y: y, edge: 'right' } };
        if (distTop < best.dist) best = { dist: distTop, res: { x: x, y: y - 1, edge: 'bottom' } };

        return best.res;
    };

    // Color Helpers - Robust Implementation
    const parseColor = (color) => {
        let r = 0, g = 0, b = 0;
        if (typeof color === 'string' && color.startsWith('#')) {
            const hex = color.replace('#', '');
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else {
                r = parseInt(hex.substring(0, 2), 16);
                g = parseInt(hex.substring(2, 4), 16);
                b = parseInt(hex.substring(4, 6), 16);
            }
        } else if (typeof color === 'string' && color.startsWith('rgb')) {
            const nums = color.match(/\d+/g);
            if (nums) {
                r = parseInt(nums[0]);
                g = parseInt(nums[1]);
                b = parseInt(nums[2]);
            }
        }
        return { r, g, b };
    };

    const toHex = (r, g, b) => {
        const to2Hex = (v) => {
            const h = Math.round(v).toString(16);
            return h.length === 1 ? '0' + h : h;
        };
        return `#${to2Hex(r)}${to2Hex(g)}${to2Hex(b)}`;
    };

    function hexToRgba(hex, alpha) {
        const { r, g, b } = parseColor(hex);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function lightenColor(color, percent) {
        let { r, g, b } = parseColor(color);
        r = Math.min(255, r + (255 - r) * (percent / 100));
        g = Math.min(255, g + (255 - g) * (percent / 100));
        b = Math.min(255, b + (255 - b) * (percent / 100));
        return toHex(r, g, b);
    }

    function darkenColor(color, percent) {
        let { r, g, b } = parseColor(color);
        r = Math.max(0, r * (1 - percent / 100));
        g = Math.max(0, g * (1 - percent / 100));
        b = Math.max(0, b * (1 - percent / 100));
        return toHex(r, g, b);
    }

    // Helper: Smooth Number Animation
    function animateValue(obj, end, duration, formatter) {
        if (!obj) return;
        // Cancel any existing animation on this element to prevent fighting
        if (obj.dataset.animFrame) {
            cancelAnimationFrame(parseInt(obj.dataset.animFrame));
        }

        // Parse starting value safely
        let startStr = obj.textContent.replace(/[^\d.-]/g, '');
        let start = parseFloat(startStr);
        if (isNaN(start)) start = 0;

        // If difference is tiny, just set it immediately (prevents micro-jitters)
        if (Math.abs(end - start) < 0.001) {
            obj.textContent = formatter ? formatter(end) : Math.floor(end);
            return;
        }

        const range = end - start;
        let startTime = null;

        function step(timestamp) {
            if (!startTime) startTime = timestamp;
            const progress = Math.min((timestamp - startTime) / duration, 1);

            // Ultra-Smooth Easing (Ease Out Quart)
            const ease = 1 - Math.pow(1 - progress, 4);

            const value = start + (range * ease);

            if (formatter) {
                obj.textContent = formatter(value);
            } else {
                obj.textContent = Math.floor(value);
            }

            if (progress < 1) {
                obj.dataset.animFrame = requestAnimationFrame(step);
            } else {
                // Finalize
                if (formatter) obj.textContent = formatter(end);
                else obj.textContent = Math.floor(end);
                delete obj.dataset.animFrame;
            }
        }
        obj.dataset.animFrame = requestAnimationFrame(step);
    }

    // Helper: Dynamic Door Check (Stateless)
    function hasDoor(grid, x, y, face) {
        if (!simulationRules.doorCreation) return false;

        let nx = x, ny = y;
        let faceHash = 0;
        if (face === 'top') { ny = y - 1; faceHash = 1; }
        else if (face === 'right') { nx = x + 1; faceHash = 2; }
        else if (face === 'bottom') { ny = y + 1; faceHash = 3; }
        else if (face === 'left') { nx = x - 1; faceHash = 4; }

        if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
            const neighbor = grid[ny][nx];

            // Check if neighbor is an Active Building Type (New Construction)
            // We do NOT create doors for Empty or other Existing buildings (merged walls)
            if (neighbor.name === 'WORKSHOP' || neighbor.name === 'SPORT' || neighbor.name === 'FARMING' || neighbor.name === 'GREEN') {
                // Deterministic Random Check
                // Use coordinates and face to generate a stable random value [0, 1]
                const seed = Math.abs(Math.sin(x * 12.9898 + y * 78.233 + faceHash) * 43758.5453) % 1;
                const result = seed < simulationParameters.doorChance;

                return result;
            }
        }
        return false;
    }

    function isRoad(gridX, gridY) {

        if (gridX < 0 || gridX >= numCols || gridY < 0 || gridY >= numRows) return false;
        return zoneGrid[gridY][gridX].name === 'SKELETON';
    }



    // Find connected groups of EXISTING buildings for merged rendering
    function findConnectedExistingBuildings() {
        const visited = Array(numRows).fill(null).map(() => Array(numCols).fill(false));
        const groups = [];

        const isExisting = (gx, gy) => {
            if (gx < 0 || gx >= numCols || gy < 0 || gy >= numRows) return false;
            return dataGrid[gy][gx].name === 'EXISTING' || zoneGrid[gy][gx].name === 'EXISTING_HOUSING';
        };

        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                if (!visited[y][x] && isExisting(x, y)) {
                    // Found a new group
                    const cells = [];
                    const cellsSet = new Set();
                    const queue = [{ x, y }];
                    visited[y][x] = true;

                    while (queue.length > 0) {
                        const { x: cx, y: cy } = queue.shift();
                        cells.push({ x: cx, y: cy });
                        cellsSet.add(`${cx},${cy}`);

                        // Check 4-connected neighbors (orthogonal only)
                        const neighbors = [
                            { x: cx - 1, y: cy },
                            { x: cx + 1, y: cy },
                            { x: cx, y: cy - 1 },
                            { x: cx, y: cy + 1 }
                        ];

                        for (const { x: nx, y: ny } of neighbors) {
                            if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows &&
                                !visited[ny][nx] && isExisting(nx, ny)) {
                                visited[ny][nx] = true;
                                queue.push({ x: nx, y: ny });
                            }
                        }
                    }

                    // Get bounding box
                    const minX = Math.min(...cells.map(c => c.x));
                    const maxX = Math.max(...cells.map(c => c.x));
                    const minY = Math.min(...cells.map(c => c.y));
                    const maxY = Math.max(...cells.map(c => c.y));

                    groups.push({
                        cells,
                        cellsSet,
                        minX, maxX, minY, maxY
                    });
                }
            }
        }

        return groups;
    }

    function initialize() {
        // Reset seed to the value shown in the UI so reruns are deterministic
        const seedInput = document.getElementById('seedInput');
        if (seedInput) {
            const seedVal = parseInt(seedInput.value);
            if (!isNaN(seedVal)) setSeed(seedVal);
        }
        simulationParameters.masterSeed = currentSeed;

        // Reset Progress
        tickProgress = 0;
        simulationHasRun = false; // Reset simulation state
        lastTickTime = Date.now();
        dataGrid = [], zoneGrid = [], bufferGrid = [], freezeGrid = [];
        for (let y = 0; y < numRows; y++) {
            dataGrid[y] = [], zoneGrid[y] = [], bufferGrid[y] = [], freezeGrid[y] = [];
            for (let x = 0; x < numCols; x++) {
                dataGrid[y][x] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
                // Initialize buffer with independent objects
                bufferGrid[y][x] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
                zoneGrid[y][x] = zoneTypes.NEUTRAL;
                freezeGrid[y][x] = false;
            }
        }
        // After initialization, add EXISTING buildings to EXISTING_HOUSING zones
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                if (zoneGrid[y][x].name === 'EXISTING_HOUSING') {
                    dataGrid[y][x] = { ...plotTypes.EXISTING, age: 0, treeCount: 0 };
                }
            }
        }
        currentYear = 2025;
        tickProgress = 0;

        // Hard Reset View State (Fix for Zoom/Pan artifacts)
        viewState.panX = 0;
        viewState.panY = 30;
        viewState.zoom = 0.9;
        viewState.isDragging = false;
        // Reset derived tile sizes immediately
        tileWidth = BASE_TILE_WIDTH * viewState.zoom;
        tileHeight = BASE_TILE_HEIGHT * viewState.zoom;

        historyLog = []; // Reset Analytics History

        // Initial History Record (Reset Stats to 0)
        cumulativeTrees = 0; // Reset first so calculateTrees seeds it from scratch
        calculateTrees();    // This will increment cumulativeTrees for every initial tree unit
        recordHistory(currentYear, dataGrid);


        // Initial Button State Fix
        if (currentMode === 'draw') {
            modeBtn.textContent = 'START SIMULATION';
            startBtn.disabled = true; pauseBtn.disabled = true; canvas.style.cursor = 'crosshair';
        } else {
            modeBtn.textContent = 'STOP & EDIT ZONES';
            startBtn.disabled = false; pauseBtn.disabled = false; canvas.style.cursor = 'default';
        }

        updateProgressBar();
        updateDateDisplay();
        updateStatistics();
        updateProgressBar();
        updateDateDisplay();
        updateStatistics();
        resizeCanvas(true); // Initialize correct size AND Auto-Fit
        resizeCanvas(true); // Initialize correct size AND Auto-Fit
        buildWorld(); // PixiJS: Initial scene build
        // requestRender(); // resizeCanvas calls requestRender
    }

    function startSimulation() {
        if (simulationInterval) return;
        simulationHasRun = true; // Mark that simulation has started

        // RESUME LOGIC: Restore lastTickTime based on current progress
        // This ensures the visual bar continues smoothly from where it paused
        let initialDelay = simulationParameters.tickSpeed;

        if (tickProgress > 0) {
            // Calculate how much time is remaining for this tick
            // remaining = total - elapsed
            const pctRemaining = 100 - tickProgress;
            initialDelay = (pctRemaining / 100) * simulationParameters.tickSpeed;
        }

        // Safety clamp used for the timeout
        initialDelay = Math.max(0, initialDelay);

        // Reset lastTickTime effectively to "now - elapsed" 
        // So the gameLoop calculates the correct progress immediately
        const elapsedAlready = simulationParameters.tickSpeed - initialDelay;
        lastTickTime = Date.now() - elapsedAlready;

        // Use recursive setTimeout instead of setInterval
        simulationInterval = setTimeout(runTick, initialDelay);

        const statusEl = document.getElementById('sim-status-text');
        if (statusEl) statusEl.textContent = 'RUNNING ▶';
    }

    function pauseSimulation() {
        clearTimeout(simulationInterval); // Clear Timeout
        simulationInterval = null;
        const statusEl = document.getElementById('sim-status-text');
        if (statusEl) statusEl.textContent = 'PAUSED ⏸';
    }


    function runTick() {
        lastTickTime = Date.now(); // Reset progress animation
        tickProgress = 0;

        // tickProgress += 100 / (simulationParameters.tickSpeed / 50); // REMOVE OLD LOGIC
        // if (tickProgress >= 100) { // REMOVE OLD LOGIC
        // tickProgress = 0; // Handled above
        currentYear++;
        updateDateDisplay();

        // Green Lung: check the paved share of the village once, before this year's decisions
        greenLungActive = simulationRules.greenLung && getPavedPct(dataGrid) >= GREEN_LUNG_MAX_PAVED;

        // DOUBLE BUFFERING: Use persistent bufferGrid as target
        // We use 'nextDataGrid' alias for clarity (this is the WRITE target)
        const nextDataGrid = bufferGrid;

        // Helper to ensure consistency when a merged plot changes state (dies or changes type)
        const checkAndUnmergePastPartner = (plot, x, y, grid) => {
            const px = plot.mergedWith.x;
            const py = plot.mergedWith.y;
            // Check if partner is "Past" (already processed in this tick)
            // If so, we must forcibly update them in the 'nextDataGrid' because they won't run their Self-Healing check again this tick.
            // If partner is "Future", we do nothing; their Self-Healing check will see we have changed and unmerge them automatically.
            const isPast = (py < y) || (py === y && px < x);

            if (isPast) {
                const partner = grid[py][px];
                // Verify it's the right partner before nuking (paranoia check)
                // Note: partner.name has already been synced to nextDataGrid, matching current plot's OLD name.
                if (partner.name === plot.name) {
                    partner.mergedWith = null;
                    partner.isMergeMaster = false;
                    partner.occupiedQuad = -1;
                    if (partner.name === 'SPORT') {
                        partner.variant = 0; // Reset to Soccer default on decay
                    }
                }
            }
        };

        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                spatialCallCount = 0; // RESET PRNG OFFSET FOR THIS PLOT
                const currentPlot = dataGrid[y][x]; // READ Source
                const nextPlot = nextDataGrid[y][x]; // WRITE Target
                const zone = zoneGrid[y][x];

                // 1. SYNC STATE: Reset target to match source baseline or clear garbage
                // Since we are writing the "future" state, we must ensure it doesn't hold old garbage from 2 ticks ago.
                // Copy core props from source to ensure stability, then modify if needed.
                nextPlot.name = currentPlot.name;
                nextPlot.age = currentPlot.age;
                nextPlot.treeCount = 0; // Always reset tree count for recalc
                nextPlot.mergedWith = currentPlot.mergedWith ? { ...currentPlot.mergedWith } : null; // Clone position object
                // nextPlot.doors removed - dynamic calc
                nextPlot.isMergeMaster = currentPlot.isMergeMaster;
                nextPlot.occupiedQuad = currentPlot.occupiedQuad;
                nextPlot.value = currentPlot.value;
                nextPlot.color = currentPlot.color; // CRITICAL: Sync color for rendering
                nextPlot.scoreColor = currentPlot.scoreColor; // Persist color cache if any
                nextPlot.scoreColor = currentPlot.scoreColor; // Persist color cache if any
                nextPlot.variant = currentPlot.variant; // Persist visual variant
                nextPlot.paths = currentPlot.paths ? { ...currentPlot.paths } : null; // CRITICAL: Persist Paths
                // Aggressively re-roll 0-rotation Green plots to fix stuck orientation
                let rot = currentPlot.rotation;
                if (currentPlot.name === 'GREEN' && (rot === undefined || (rot === 0 && nextRandom(x, y) < 0.2))) {
                    rot = Math.floor(nextRandom(x, y) * 4);
                }
                nextPlot.rotation = (rot !== undefined) ? rot : 0;
                nextPlot.hasRoofGarden = currentPlot.hasRoofGarden; // Persist Roof Garden
                nextPlot.decayStage = currentPlot.decayStage || 0; // Persist Decay Stage

                // 1b. SELF-HEALING: Check consistency with ALREADY PROCESSED (Past) partners
                // If my partner was processed before me and died (or divorced me), I must accept it.
                if (nextPlot.mergedWith) {
                    const px = nextPlot.mergedWith.x;
                    const py = nextPlot.mergedWith.y;
                    const isPast = (py < y) || (py === y && px < x);

                    if (isPast) {
                        const partner = nextDataGrid[py][px];
                        // If partner is not what we expect (e.g. Type changed, or link broken)
                        // Note: We check if partner points to US.
                        if (partner.name !== nextPlot.name ||
                            !partner.mergedWith ||
                            partner.mergedWith.x !== x ||
                            partner.mergedWith.y !== y) {

                            // Partner is gone/changed. We must un-merge.
                            nextPlot.mergedWith = null;
                            nextPlot.isMergeMaster = false;
                            nextPlot.occupiedQuad = -1;
                            if (nextPlot.name === 'SPORT') {
                                nextPlot.variant = 0; // Reset to Soccer default on decay
                            }
                        }
                    }
                }

                // Topping Rule: Roof Gardens on Existing Buildings
                if (simulationRules.toppingRule && (currentPlot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING')) {
                    // Only spawn if not already present
                    if (!nextPlot.hasRoofGarden && nextRandom(x, y) < simulationParameters.toppingChance) {
                        nextPlot.hasRoofGarden = true;
                    }
                }

                // Skip fixed plots
                if (zone.name === 'SKELETON' || zone.name === 'EXISTING_HOUSING' || zone.name === 'AQUEDUCT' || currentPlot.name === 'EXISTING' || currentPlot.name === 'REMOVED') {
                    continue;
                }

                // Skip frozen plots and NONE zones (Freeze Tool/NONE: no decay, spawn, type change, aging)
                if ((freezeGrid[y] && freezeGrid[y][x]) || zone.name === 'NONE') {
                    continue;
                }

                // 2. SIMULATION LOGIC (Mutate nextPlot)
                if (currentPlot.name === 'EMPTY') {
                    const newPlotType = getDevelopmentChance(x, y);
                    if (newPlotType) {
                        // Transformation: Update nextPlot to new type
                        const template = plotTypes[newPlotType];
                        nextPlot.name = template.name;
                        nextPlot.value = template.value;
                        nextPlot.color = template.color; // CRITICAL: Update color
                        // color handles in draw

                        if (nextPlot.name === 'GREEN') {
                            nextPlot.variant = Math.floor(nextRandom(x, y) * 3);
                            nextPlot.rotation = Math.floor(nextRandom(x, y) * 4);
                        } else {
                            nextPlot.variant = 0;
                        }

                        nextPlot.age = 0;
                        nextPlot.treeCount = 0;
                        nextPlot.mergedWith = null;
                        nextPlot.isMergeMaster = false;
                        nextPlot.decayStage = 0; // CRITICAL: Ensure fresh plot is not dying
                        nextPlot.hasRoofGarden = false;
                    }
                } else {
                    let plotWillChange = false;

                    const currentStage = currentPlot.decayStage || 0;

                    // Decay Logic (Multi-Stage)
                    if (currentStage > 0) {
                        // Already dying -> Increment
                        nextPlot.decayStage = currentStage + 1;

                        // Duration: Reduced to 2 ticks for immediate feedback (approx 1-2 years)
                        // Duration: Reduced to > 1 for FAST feedback (1 tick = 1 year)
                        if (nextPlot.decayStage > 1) {
                            // Final Death
                            const template = plotTypes.EMPTY;
                            nextPlot.name = template.name;
                            nextPlot.value = template.value;
                            nextPlot.color = template.color;
                            nextPlot.age = 0;
                            nextPlot.treeCount = 0;
                            nextPlot.mergedWith = null;
                            nextPlot.isMergeMaster = false;
                            nextPlot.mergedWith = null;
                            nextPlot.isMergeMaster = false;
                            nextPlot.decayStage = 0; // Reset
                            nextPlot.hasRoofGarden = false; // CRITICAL: Reset Roof Garden on Death

                            // Handle Partner Un-merge
                            if (currentPlot.mergedWith) {
                                checkAndUnmergePastPartner(currentPlot, x, y, nextDataGrid);
                            }
                        }
                        plotWillChange = true;
                    }
                    else if (nextRandom(x, y) < simulationParameters.decayChance) {
                        // Start Dying
                        nextPlot.decayStage = 1;
                        plotWillChange = true;
                    }
                    else if (currentPlot.age + 1 >= simulationParameters.reEvaluationAge && nextRandom(x, y) < simulationParameters.changeChance) {
                        const newPlotType = getDevelopmentChance(x, y);
                        if (newPlotType && newPlotType !== currentPlot.name) {
                            // Change Type
                            const template = plotTypes[newPlotType];
                            nextPlot.name = template.name;
                            nextPlot.value = template.value;
                            nextPlot.color = template.color; // CRITICAL: Update color
                            if (nextPlot.name === 'GREEN') {
                                nextPlot.variant = Math.floor(nextRandom(x, y) * 3); // 0=Park, 1=Garden, 2=Wilderness
                            } else {
                                nextPlot.variant = 0;
                            }
                            nextPlot.age = 0;
                            nextPlot.treeCount = 0;
                            nextPlot.mergedWith = null;
                            nextPlot.isMergeMaster = false;
                            nextPlot.decayStage = 0; // CRITICAL: Reset decay on change
                            nextPlot.hasRoofGarden = false;

                            // NEW: Ensure we unmerge from partner if we change type!
                            if (currentPlot.mergedWith) {
                                checkAndUnmergePastPartner(currentPlot, x, y, nextDataGrid);
                            }

                            plotWillChange = true;
                        }
                    }

                    if (!plotWillChange) {
                        nextPlot.age++;
                    }
                }
            }
        }

        // SWAP REFERENCES (dataGrid becomes the updated one)
        // bufferGrid becomes the old one (to be overwritten next tick)
        let temp = dataGrid;
        dataGrid = nextDataGrid; // bufferGrid
        bufferGrid = temp;       // old dataGrid

        // NEW: Run Post-Update Passes using the NEW dataGrid

        // Unified Merge Pass (Farming, Workshop, Sport)
        // Combined into single loop to reduce iteration overhead
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                spatialCallCount = 100; // Offset for merge phase
                const plot = dataGrid[y][x];

                // Skip if already merged
                if (plot.mergedWith) continue;
                // Skip frozen plots and NONE zones (cannot initiate merges)
                if ((freezeGrid[y] && freezeGrid[y][x]) || zoneGrid[y][x].name === 'NONE') continue;

                let targetName = null;
                let mergeAge = 0;
                let mergeChance = 0;
                let isSport = false;

                if (plot.name === 'FARMING') {
                    targetName = 'FARMING';
                    mergeAge = simulationParameters.farmingMergeAge;
                    mergeChance = simulationParameters.farmingMergeChance;
                } else if (plot.name === 'WORKSHOP') {
                    targetName = 'WORKSHOP';
                    mergeAge = simulationParameters.workshopMergeAge;
                    mergeChance = simulationParameters.workshopMergeChance;
                } else if (plot.name === 'SPORT') {
                    targetName = 'SPORT';
                    mergeAge = simulationParameters.farmingMergeAge; // Uses farming age param
                    mergeChance = simulationParameters.farmingMergeChance; // Uses farming chance param
                    isSport = true;
                } else if (plot.name === 'GREEN') {
                    targetName = 'GREEN';
                    mergeAge = simulationParameters.greenMergeAge;
                    mergeChance = simulationParameters.greenMergeChance;
                }

                if (simulationRules.allowMerging && targetName && plot.age >= mergeAge) {
                    // Check Neighbors (Right and Bottom only to avoid double checking)
                    const candidates = [
                        { nx: x + 1, ny: y, pathType: 'right' },
                        { nx: x, ny: y + 1, pathType: 'bottom' }
                    ];

                    for (const cand of candidates) {
                        const { nx, ny, pathType } = cand;

                        // 1. Boundary Check
                        if (nx >= numCols || ny >= numRows) continue;

                        // 1b. Frozen/NONE neighbor check
                        if ((freezeGrid[ny] && freezeGrid[ny][nx]) || zoneGrid[ny][nx].name === 'NONE') continue;

                        // 2. Path Obstruction Check
                        if (plot.paths && plot.paths[pathType]) continue;

                        // 3. Neighbor Validity Check
                        const neighbor = dataGrid[ny][nx];
                        if (neighbor.name === targetName && !neighbor.mergedWith && neighbor.age >= mergeAge) {
                            if (nextRandom(x, y) < mergeChance) {
                                // EXECUTE MERGE
                                plot.mergedWith = { x: nx, y: ny };
                                neighbor.mergedWith = { x: x, y: y };
                                plot.isMergeMaster = true;
                                neighbor.isMergeMaster = false;

                                if (isSport) {
                                    // Sport Variant Logic (Tennis)
                                    plot.variant = 3;
                                    neighbor.variant = 3;
                                    const tennisColor = '#FFAB91';
                                    plot.color = tennisColor;
                                    neighbor.color = tennisColor;
                                } else if (targetName === 'GREEN') {
                                    // MOVEMENT: Lighter Green for Merged Park
                                    const parkColor = '#B7E4C7'; // Lighter than #95D5B2
                                    plot.color = parkColor;
                                    neighbor.color = parkColor;
                                }

                                break; // Stop looking after successful merge
                            }
                        }
                    }
                }
            }
        }

        calculateTrees();

        // CUMULATIVE TREE TRACKING: count GREEN plots that DECAYED to EMPTY.
        // bufferGrid holds the previous tick's state (names intact after the swap above).
        // totalPlanted = currentGreenPlots + historicallyDecayedGreenPlots, always >= currentTrees.
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const prevName = bufferGrid[y][x].name;
                const newName  = dataGrid[y][x].name;
                // Plot was GREEN last tick and is now EMPTY → trees are lost, preserve in total
                if (prevName === 'GREEN' && newName === 'EMPTY') {
                    cumulativeTrees++;
                }
            }
        }

        applyScoringRule();
        calculateQuadrants(dataGrid); // NEW: Pre-calculate visual quadrants
        updateStatisticsRefined();


        // Record History
        recordHistory(currentYear, dataGrid);

        // A tick only changes plot data, so buildWorld() may redraw just the changed tiles —
        // unless something else already asked for a full rebuild.
        const fullWasNeeded = fullRebuildNeeded;
        invalidateStaticCache(); // Invalidate on Tick
        requestRender();
        fullRebuildNeeded = fullWasNeeded;

        if (activeTab === 'graph') {
            drawGraph();
        }

        updateProgressBar();

        // Live Inspector Update
        if (activeInspectorPlot) {
            updateInspectorContent(activeInspectorPlot.x, activeInspectorPlot.y);
        }

        // RECURSIVE LOOP: Schedule next tick
        if (simulationInterval) { // Only if not paused during execution
            // Note: startSimulation sets simulationInterval to the ID.
            // pauseSimulation sets it to null.
            // But here we need to re-assign it.
            // However, checking 'simulationInterval !== null' determines if we should continue.
            simulationInterval = setTimeout(runTick, simulationParameters.tickSpeed);
        }
    }

    // Global helper for quadrant calculation
    // OPTIMIZATION: Localized Quadrant Update
    function updateCellQuadrant(x, y, grid) {
        if (x < 0 || x >= numCols || y < 0 || y >= numRows) return;

        const plot = grid[y][x];
        plot.occupiedQuad = -1; // Reset

        if (plot.name !== 'WORKSHOP' && plot.name !== 'FARMING') return;

        if (plot.mergedWith) {
            plot.occupiedQuad = 4; // Full/Merged
            return;
        }

        const seed = (x * 37 + y * 13);
        const neighborTop = (y > 0 && (grid[y - 1][x].name === 'WORKSHOP' || grid[y - 1][x].name === 'FARMING'));
        const neighborRight = (x < numCols - 1 && (grid[y][x + 1].name === 'WORKSHOP' || grid[y][x + 1].name === 'FARMING'));
        const neighborBottom = (y < numRows - 1 && (grid[y + 1][x].name === 'WORKSHOP' || grid[y + 1][x].name === 'FARMING'));
        const neighborLeft = (x > 0 && (grid[y][x - 1].name === 'WORKSHOP' || grid[y][x - 1].name === 'FARMING'));

        const roadTL = isRoad(x - 1, y) || (plot.paths && plot.paths.left) || (x > 0 && grid[y][x - 1].paths && grid[y][x - 1].paths.right); // Left
        const roadTR = isRoad(x, y - 1) || (plot.paths && plot.paths.top) || (y > 0 && grid[y - 1][x].paths && grid[y - 1][x].paths.bottom); // Top
        const roadBR = isRoad(x + 1, y) || (plot.paths && plot.paths.right); // Right
        const roadBL = isRoad(x, y + 1) || (plot.paths && plot.paths.bottom); // Bottom

        let qScores = [0, 0, 0, 0];
        if (neighborTop) qScores[0] += 10;
        if (neighborLeft) qScores[0] += 10;
        if (neighborTop) qScores[1] += 10;
        if (neighborRight) qScores[1] += 10;
        if (neighborRight) qScores[2] += 10;
        if (neighborBottom) qScores[2] += 10;
        if (neighborBottom) qScores[3] += 10;
        if (neighborLeft) qScores[3] += 10;

        if (simulationRules.buildingRoadConstraint) {
            if (roadTL || roadTR) qScores[0] = -100;
            if (roadTR || roadBR) qScores[1] = -100;
            if (roadBR || roadBL) qScores[2] = -100;
            if (roadBL || roadTL) qScores[3] = -100;
        }

        let maxScore = Math.max(...qScores);
        let candidates = [];
        if (maxScore > -100) {
            for (let i = 0; i < 4; i++) if (qScores[i] === maxScore) candidates.push(i);
        }

        // FARMING BUILDING CONSTRAINT
        if (plot.name === 'FARMING') {
            let layout = getFarmingLayout(x, y);

            const getQuads = (l) => {
                if (l.split === 'X') return l.brownFirst ? [1, 2] : [0, 3];
                else return l.brownFirst ? [2, 3] : [0, 1];
            };

            const isSafe = (q) => {
                // Check qScores (Road/Path Constraints). -100 means blocked.
                if (simulationRules.buildingRoadConstraint && qScores[q] <= -50) return false;

                // Check Existing Neighbors (only if farmingNeighbor rule is enabled)
                if (simulationRules.farmingNeighbor) {
                    let check = [];
                    if (q === 0) check = [{ dx: 0, dy: -1 }, { dx: -1, dy: 0 }];
                    if (q === 1) check = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }];
                    if (q === 2) check = [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }];
                    if (q === 3) check = [{ dx: 0, dy: 1 }, { dx: -1, dy: 0 }];

                    for (let c of check) {
                        const nx = x + c.dx, ny = y + c.dy;
                        if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                            const n = grid[ny][nx];
                            const z = zoneGrid[ny][nx];
                            if (n.name === 'EXISTING' || z.name === 'EXISTING_HOUSING') return false;
                        }
                    }
                }
                return true;
            };

            let allowedQuads = getQuads(layout);
            let validCandidates = allowedQuads.filter(q => isSafe(q));

            if (validCandidates.length === 0) {
                // AUTO ROTATION: Try other layouts
                const perms = [
                    { split: 'X', brownFirst: false },
                    { split: 'X', brownFirst: true },
                    { split: 'Y', brownFirst: false },
                    { split: 'Y', brownFirst: true }
                ];

                for (let p of perms) {
                    const pQuads = getQuads(p);
                    const pValid = pQuads.filter(q => isSafe(q));

                    if (pValid.length > 0) {
                        layout = p;
                        plot.farmingLayout = p; // PERSIST ROTATION
                        candidates = pValid;
                        break;
                    }
                }
            } else {
                candidates = validCandidates;
            }

        }

        if (candidates.length > 0) {
            plot.occupiedQuad = candidates[seed % candidates.length];
        } else {
            // NO VALID QUADRANTS: Convert to GREEN (all sides blocked by roads/paths)
            plot.occupiedQuad = -1;
            Object.assign(plot, { ...plotTypes.GREEN, age: plot.age || 0, treeCount: 0 });
        }
    }

    // Global helper for quadrant calculation
    function calculateQuadrants(grid) {
        // PRE-CALCULATE WORKSHOP QUADRANTS to ensure consistent neighbor detection
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                updateCellQuadrant(x, y, grid);
            }
        }
    }

    function recordHistory(year, grid) {
        let green = 0, farm = 0, sport = 0, workshop = 0, empty = 0;
        let totalTrees = 0;
        let paved = 0; // Workshop + Sport + Skeleton
        let greenSpace = 0; // Green + Farming

        // Helper to check if plot is Existing
        const isExisting = (gx, gy) => {
            if (gx < 0 || gx >= numCols || gy < 0 || gy >= numRows) return false;
            const p = grid[gy][gx];
            const z = zoneGrid[gy][gx];
            return p.name === 'EXISTING' || (z && z.name === 'EXISTING_HOUSING');
        };

        // Helper: returns true for plots that do NOT participate in the simulation
        const isNonParticipating = (p, z) => {
            return p.name === 'REMOVED' ||
                   p.name === 'EXISTING' ||
                   z.name === 'NONE' ||
                   z.name === 'SKELETON' ||
                   z.name === 'AQUEDUCT' ||
                   z.name === 'EXISTING_HOUSING';
        };

        // 1. Iterate Grid for Main Types & Plot-Specifics
        let activePlots = 0;   // Only active/participating plots count toward composition %
        let surfacePlots = 0;  // All plots except NONE zones — used for paved/bio denominator
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = grid[y][x];
                const z = zoneGrid[y][x];

                // Skip non-participating plots for composition counts
                if (!isNonParticipating(p, z)) {
                    activePlots++;
                    // Main Usage Counts (for Graph) — active plots only
                    if (p.name === 'GREEN') green++;
                    else if (p.name === 'FARMING') farm++;
                    else if (p.name === 'SPORT') sport++;
                    else if (p.name === 'WORKSHOP') workshop++;
                    else if (p.name === 'EMPTY') empty++;
                }

                // Current Trees = count of GREEN plots (the plots that visually have trees)
                if (p.name === 'GREEN') totalTrees++;

                // Track Paved vs GreenSpace — skip NONE zone plots entirely (not part of the site)
                // 1. Fully Paved: WORKSHOP, SPORT, EXISTING, or Road (SKELETON zone)
                // 2. Bio-Permeable: GREEN, FARMING, AQUEDUCT zone, EMPTY, REMOVED
                if (z.name === 'NONE') continue; // NONE = excluded zone, not counted in surface area

                surfacePlots++; // Only participating surface plots count toward the denominator

                const isBuilt = (p.name === 'WORKSHOP' || p.name === 'SPORT');
                const isExistingBldg = (p.name === 'EXISTING');
                const isRoad = (z.name === 'SKELETON');

                // Calculate Path Area for ALL plots (paths can exist anywhere technically)
                let pathArea = 0;
                const singlePathArea = 0.13;
                if (p.paths && p.paths.right) pathArea += singlePathArea;
                if (p.paths && p.paths.bottom) pathArea += singlePathArea;
                if (x > 0 && grid[y][x - 1].paths && grid[y][x - 1].paths.right) pathArea += singlePathArea;
                if (y > 0 && grid[y - 1][x].paths && grid[y - 1][x].paths.bottom) pathArea += singlePathArea;

                if (isBuilt || isExistingBldg || isRoad) {
                    // Fully Paved: 100% counts as Paved.
                    paved += 1.0;
                } else {
                    // Permeable (Green, Farm, Aqueduct, Empty, Removed, Dirt)
                    // Paved contribution is ONLY the paths on these tiles.
                    paved += pathArea;
                    greenSpace += Math.max(0, 1.0 - pathArea);
                }
            }
        }

        // surfacePlots = all plots except NONE zones (paved + bio sums to 100% of the actual site)
        const fullTotal = surfacePlots > 0 ? surfacePlots : 1;
        // activePlots = only participating plots for composition % (GREEN/FARM/SPORT/WORK/EMPTY)
        const total = activePlots > 0 ? activePlots : 1;

        // NEW STATS CALCULATION
        let sumAge = 0;
        let countAge = 0;
        let wTotal = 0, wMerged = 0;
        let fTotal = 0, fMerged = 0;
        let sTotal = 0, sMerged = 0;
        let gTotal = 0, gMerged = 0;
        let totalDoors = 0;

        // Re-iterate (or could have done in main loop, but this keeps logic clean)
        // Actually, let's keep it separate for clarity unless perf is critical (it's not).
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = grid[y][x];
                // Age (Only count active types)
                if (p.name === 'GREEN' || p.name === 'FARMING' || p.name === 'SPORT' || p.name === 'WORKSHOP') {
                    sumAge += p.age;
                    countAge++;
                }
                // Merged Stats
                if (p.name === 'WORKSHOP') {
                    wTotal++;
                    if (p.mergedWith) wMerged++;
                }
                if (p.name === 'FARMING') {
                    fTotal++;
                    if (p.mergedWith) fMerged++;
                }
                if (p.name === 'SPORT') {
                    sTotal++;
                    if (p.mergedWith) sMerged++;
                }
                if (p.name === 'GREEN') {
                    gTotal++;
                    if (p.mergedWith) gMerged++;
                }

                // Count Doors (Dynamic)
                // We count ALL doors if they exist (Top, Right, Bottom, Left)
                if (isExisting(x, y)) { // Only check Existing buildings
                    if (hasDoor(grid, x, y, 'top')) totalDoors++;
                    if (hasDoor(grid, x, y, 'right')) totalDoors++;
                    if (hasDoor(grid, x, y, 'bottom')) totalDoors++;
                    if (hasDoor(grid, x, y, 'left')) totalDoors++;
                }
            }
        }

        const avgAge = countAge > 0 ? (sumAge / countAge) : 0;
        const wPct = wTotal > 0 ? (wMerged / wTotal) * 100 : 0;
        const fPct = fTotal > 0 ? (fMerged / fTotal) * 100 : 0;
        const sPct = sTotal > 0 ? (sMerged / sTotal) * 100 : 0;
        const gPct = gTotal > 0 ? (gMerged / gTotal) * 100 : 0;

        // Diversity (Shannon Entropy) for [GREEN, FARMING, SPORT, WORKSHOP]
        const activeTotal = green + farm + sport + workshop;
        let diversity = 0;
        if (activeTotal > 0) {
            const counts = [green, farm, sport, workshop];
            let entropy = 0;
            counts.forEach(c => {
                if (c > 0) {
                    const p = c / activeTotal;
                    entropy -= p * Math.log2(p);
                }
            });
            // Max entropy for 4 categories is log2(4) = 2
            diversity = (entropy / 2) * 100;
        }

        // PARTICIPATING PLOTS: reuse standalone function for consistency
        const participatingPlots = calculateParticipatingPlots();

        historyLog.push({
            year,
            GREEN: (green / total) * 100,
            FARMING: (farm / total) * 100,
            SPORT: (sport / total) * 100,
            WORKSHOP: (workshop / total) * 100,
            EMPTY: (empty / total) * 100,
            // Raw Stats
            stats: {
                totalTrees,
                totalDoors,
                pavedPct: (paved / fullTotal) * 100,
                greenPct: (greenSpace / fullTotal) * 100,
                avgAge,
                mergedWorkshop: wPct,
                mergedFarming: fPct,
                mergedSport: sPct,
                mergedGreen: gPct,
                diversity,
                totalPlanted: totalTrees + cumulativeTrees, // current + historically decayed tree plots
                participatingPlots
            }
        });
    }

    // STANDALONE: Calculates participating plots live from current dataGrid/zoneGrid.
    // Works without the simulation running — called on tab switch and after each tick.
    function calculateParticipatingPlots() {
        if (!dataGrid || !zoneGrid || dataGrid.length === 0) return 0;
        let excluded = 0;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = dataGrid[y][x];
                const z = zoneGrid[y][x];
                if (!p || !z) continue;
                if (p.name === 'REMOVED' ||
                    z.name === 'NONE' ||
                    z.name === 'SKELETON' ||
                    z.name === 'AQUEDUCT' ||
                    z.name === 'EXISTING_HOUSING') {
                    excluded++;
                }
            }
        }
        return numRows * numCols - excluded;
    }

    function updateParticipatingPlotsDisplay() {
        const el = document.getElementById('stat-participating');
        if (!el) return;
        const val = calculateParticipatingPlots();
        animateValue(el, val, 600, (v) => Math.floor(v).toLocaleString());
    }

    function drawGraph() {
        const graphCanvas = document.getElementById('graphCanvas');
        if (!graphCanvas) return;

        // FIX: Auto-resize to container (CSS likely sets 100%, but canvas internal buffer needs match)
        const container = graphCanvas.parentElement;
        if (container) {
            // Only resize if different to avoid flicker, or simplify by always setting
            if (graphCanvas.width !== container.clientWidth || graphCanvas.height !== container.clientHeight) {
                graphCanvas.width = container.clientWidth;
                graphCanvas.height = container.clientHeight;
            }
        }

        const ctx = graphCanvas.getContext('2d');
        const width = graphCanvas.width;
        const height = graphCanvas.height;

        // Check isDarkMode state dynamically
        const isDark = document.body.classList.contains('dark-mode');

        // Clear (Transparent background to show container color)
        ctx.clearRect(0, 0, width, height);

        // Update Dashboard KPIs (Run BEFORE early return check)
        const latest = historyLog[historyLog.length - 1];
        if (latest && latest.stats) {
            const elYear = document.getElementById('stat-year');
            const elTrees = document.getElementById('stat-trees');
            const elPaved = document.getElementById('stat-paved');
            const elGreen = document.getElementById('stat-green');

            // New Stats
            const elAge = document.getElementById('stat-age');
            const elMergedW = document.getElementById('stat-merged-workshop');
            const elMergedF = document.getElementById('stat-merged-farming');
            const elMergedS = document.getElementById('stat-merged-sport');
            const elMergedG = document.getElementById('stat-merged-green');
            const elDiversity = document.getElementById('stat-diversity');
            const elDoors = document.getElementById('stat-doors');
            const elTotalPlanted = document.getElementById('stat-total-planted'); // NEW
            const elParticipating = document.getElementById('stat-participating');

            if (elYear) animateValue(elYear, latest.year, 600);
            if (elTrees) animateValue(elTrees, latest.stats.totalTrees, 1000, (val) => Math.floor(val).toLocaleString());
            if (elPaved) animateValue(elPaved, latest.stats.pavedPct, 800, (val) => val.toFixed(1) + "%");
            if (elGreen) animateValue(elGreen, latest.stats.greenPct, 800, (val) => val.toFixed(1) + "%");

            if (elAge) animateValue(elAge, latest.stats.avgAge, 800, (val) => val.toFixed(1) + " Yrs");
            if (elMergedW) animateValue(elMergedW, latest.stats.mergedWorkshop, 800, (val) => val.toFixed(0) + "%");
            if (elMergedF) animateValue(elMergedF, latest.stats.mergedFarming, 800, (val) => val.toFixed(0) + "%");
            if (elMergedS) animateValue(elMergedS, latest.stats.mergedSport, 800, (val) => val.toFixed(0) + "%");
            if (elMergedG) animateValue(elMergedG, latest.stats.mergedGreen, 800, (val) => val.toFixed(0) + "%");
            if (elDiversity) animateValue(elDiversity, latest.stats.diversity, 800, (val) => val.toFixed(0));
            if (elDoors) animateValue(elDoors, latest.stats.totalDoors, 1000, (val) => Math.floor(val).toLocaleString());
            if (elTotalPlanted) {
                const newVal = latest.stats.totalPlanted || 0;
                // Track last target value to prevent re-animation while animation is in progress
                const lastTarget = parseFloat(elTotalPlanted.dataset.lastTarget) || 0;
                if (Math.abs(newVal - lastTarget) > 0.5) {
                    elTotalPlanted.dataset.lastTarget = newVal;
                    animateValue(elTotalPlanted, newVal, 1000, (val) => Math.floor(val).toLocaleString());
                }
            }
            if (elParticipating) animateValue(elParticipating, latest.stats.participatingPlots || 0, 800, (val) => Math.floor(val).toLocaleString());
        }

        if (historyLog.length < 2) {
            ctx.fillStyle = isDark ? '#CBD5E0' : '#4A5568';
            ctx.font = 'bold 16px Inter, sans-serif'; // Reduced from 20
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("Running Simulation...", width / 2, height / 2);
            return;
        }

        // Config - Optimized for Bigger Display
        const margin = { top: 20, right: 20, bottom: 55, left: 60 }; // Increased bottom margin further for label spacing
        const graphW = width - margin.left - margin.right;
        const graphH = height - margin.top - margin.bottom;
        const startX = margin.left;
        const startY = height - margin.bottom;
        const endX = width - margin.right;

        // Draw Axes
        ctx.strokeStyle = isDark ? '#4A5568' : '#718096';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, margin.top); // Top Y
        ctx.lineTo(startX, startY); // Bottom-Left Corner
        ctx.lineTo(endX, startY); // Right X
        ctx.stroke();

        // Draw Guidelines (25%, 50%, 75%, 100%)
        ctx.font = 'bold 12px "Space Mono", monospace'; // Match UI Data Font
        ctx.fillStyle = isDark ? '#A0AEC0' : '#4A5568';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        [0, 25, 50, 75, 100].forEach(p => {
            const y = startY - (graphH * (p / 100));
            ctx.fillText(p + "%", startX - 20, y);
            ctx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
            ctx.fillRect(startX, y, graphW, 2); // Grid line
            ctx.fillStyle = isDark ? '#A0AEC0' : '#4A5568'; // Reset text color
        });

        // Draw Labels (X-Axis) - Every ~5th year or optimal spacing
        ctx.font = '500 12px "Space Mono", monospace'; // Match UI Data Font
        ctx.fillStyle = isDark ? '#A0AEC0' : '#4A5568';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const labelStep = Math.ceil(historyLog.length / 10); // Show max 10 labels
        historyLog.forEach((entry, i) => {
            if (i % labelStep === 0 || i === historyLog.length - 1) {
                const x = startX + (i / (historyLog.length - 1)) * graphW;
                ctx.fillText(entry.year, x, startY + 10);

                // Small tick mark
                ctx.fillRect(x - 1, startY, 2, 5);
            }
        });

        // STACKED AREA DATA PREP
        // Categories Bottom -> Top:
        const categories = [
            { key: 'EMPTY', color: plotTypes.EMPTY.color || '#CBD5E0' }, // Fallback logic
            { key: 'WORKSHOP', color: plotTypes.WORKSHOP.color },
            { key: 'SPORT', color: plotTypes.SPORT.color },
            { key: 'FARMING', color: plotTypes.FARMING.color },
            { key: 'GREEN', color: plotTypes.GREEN.color }
        ];

        // Specific overrides for Graph contrast if needed (optional)
        // Adjust Empty color for Dark Mode
        if (isDark) categories[0].color = '#4A5568';


        // Helper to get Y for a specific time index and accumulated percent
        const getY = (index, percent) => {
            const x = startX + (index / (historyLog.length - 1)) * graphW;
            const y = startY - (graphH * (percent / 100));
            return { x, y };
        };

        // Draw Layers
        // We draw from Top to Bottom? No, Stacked means we draw cumulative.
        // Easiest is to draw filled paths for each "horizon".
        // Base is 0.
        // Layer 1 Top = L1.
        // Layer 2 Top = L1 + L2.
        // ...
        // Layer N Top = 100%.

        // Pre-calculate stack points
        const stackData = historyLog.map(entry => {
            let acc = 0;
            const point = { year: entry.year };
            categories.forEach(cat => {
                acc += entry[cat.key] || 0;
                point[cat.key] = acc; // Store cumulative top
            });
            // Ensure 100% at top (fix floating point drift)
            if (acc < 99.9) point[categories[categories.length - 1].key] = 100;
            return point;
        });

        // Draw each layer (Back to Front / Bottom to Top)
        // Actually, "Area" means filling between Current Cumulative and Previous Cumulative.
        // But since we are stacking, we can just draw the "Top" curve down to the "Bottom" curve.
        // Or simpler: Draw the "Top" curve down to 0, fill with Top Color.
        // Then draw Next Layer down to 0, fill with Next Color.
        // This paints over the hidden parts.
        // Order: Standard Painter's Algorithm: Draw Top-Most Cumulative (which is 100% usually) FIRST?
        // No, if L1 is bottom, L2 is on top...
        // 0 -> L1 (Fill L1 Color)
        // 0 -> L1+L2 (Fill L2 Color) ?? No that covers L1.
        // We need to fill 0->L1+L2+L3... (which is 100%) with LAST Color.
        // Then fill 0->L1+L2 with Middle Color.
        // ...
        // Then fill 0->L1 with Bottom Color.
        // CORRECT: Reverse Order of Categories.

        for (let i = categories.length - 1; i >= 0; i--) {
            const cat = categories[i];
            const catKey = cat.key;

            ctx.fillStyle = cat.color;
            ctx.beginPath();

            // Start Bottom-Left (but actually using stack data)
            // First point
            const p0 = getY(0, stackData[0][catKey]);
            ctx.moveTo(p0.x, startY); // Start at bottom for fill? 
            // No, we want to fill the area UNDER this curve.
            // Since we paint over, we treat "Ground" as 0.
            ctx.lineTo(p0.x, p0.y);

            for (let j = 1; j < stackData.length; j++) {
                const p = getY(j, stackData[j][catKey]);
                ctx.lineTo(p.x, p.y);
            }

            // Close Path to Bottom-Right, then Bottom-Left
            ctx.lineTo(endX, startY);
            ctx.lineTo(startX, startY);
            ctx.closePath();
            ctx.fill();
        }

        // INTERACTION: Hover Line & Tooltip
        if (typeof graphHoverX !== 'undefined' && graphHoverX !== null && historyLog.length > 0) {
            // Fix Coordinate Scaling (CSS Pixels vs Canvas Pixels)
            const rect = graphCanvas.getBoundingClientRect();
            const scaleX = graphCanvas.width / rect.width;
            const canvasMouseX = graphHoverX * scaleX;

            // Find closest index
            const relativeX = canvasMouseX - startX;
            const ratio = Math.max(0, Math.min(1, relativeX / graphW));

            // Snap Logic
            // Snap Logic - specific year
            const rawIndex = Math.round(ratio * (historyLog.length - 1));
            // let hoverIndex = Math.round(rawIndex / labelStep) * labelStep; // Removed snap-to-grid to fix jitter
            let hoverIndex = rawIndex; // Smooth snap to nearest year

            if (hoverIndex < 0) hoverIndex = 0;
            if (hoverIndex >= historyLog.length) hoverIndex = historyLog.length - 1;

            const entry = historyLog[hoverIndex];
            if (entry) {
                // Get X coordinate for this index
                const x = startX + (hoverIndex / (historyLog.length - 1)) * graphW;

                // Draw Vertical Snap Line
                ctx.beginPath();
                ctx.moveTo(x, margin.top);
                ctx.lineTo(x, startY);
                ctx.strokeStyle = isDark ? '#FFFFFF' : '#2D3748';
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]); // Dashed line
                ctx.stroke();
                ctx.setLineDash([]); // Reset

                // Update Tooltip
                const tooltip = document.getElementById('floating-tooltip');
                if (tooltip) {
                    const totalTiles = 50 * 50;
                    const vals = {
                        'GREEN': entry.GREEN || 0,
                        'FARMING': entry.FARMING || 0,
                        'SPORT': entry.SPORT || 0,
                        'WORKSHOP': entry.WORKSHOP || 0,
                        'EMPTY': entry.EMPTY || 0
                    };

                    // Generate Tooltip Content
                    let html = `<div style="text-align:left; font-weight:700; margin-bottom:6px; border-bottom:1px solid rgba(255,255,255,0.15); padding-bottom:6px; font-size:13px; letter-spacing:0.5px; color:${isDark ? '#FFF' : '#2D3748'};">YEAR ${entry.year}</div>`;

                    const sorted = Object.entries(vals).sort((a, b) => b[1] - a[1]);

                    sorted.forEach(([key, val]) => {
                        if (val <= 0) return; // Skip zero values
                        const realPct = val.toFixed(1); // val is already percentage
                        const colorObj = categories.find(c => c.key === key);
                        const color = colorObj ? colorObj.color : '#ccc';
                        const keyName = key.charAt(0) + key.slice(1).toLowerCase();

                        html += `<div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-bottom:4px; color:${isDark ? '#E2E8F0' : '#4A5568'};">
                            <span style="display:flex; align-items:center;">
                                <span style="width:8px; height:8px; background:${color}; border-radius:3px; margin-right:8px;"></span>
                                ${keyName}
                            </span>
                            <span style="font-weight:600; font-feature-settings:'tnum';">${realPct}%</span>
                         </div>`;
                    });

                    tooltip.innerHTML = html;

                    // VISIBILITY FIX
                    tooltip.classList.add('visible');
                    tooltip.style.display = 'block';

                    // Style adjustments for tooltip to ensure it matches graph style
                    tooltip.style.padding = '12px';
                    tooltip.style.lineHeight = '1.4';

                    // Removed manual positioning here to avoid conflict with global mousemove listener
                    // The tooltip will now naturally follow the mouse cursor via the global listener.
                    // This fixes the "jumping" issue.
                }
            }
        }


    }

    // GREEN LUNG (rulebook 1.03): at most 40% of the village surface may be paved
    const GREEN_LUNG_MAX_PAVED = 40;
    let greenLungActive = false; // Set at the start of every tick

    // Share of the village surface that is paved (0-100). Same definition as the "Paved Surface" KPI in recordHistory().
    function getPavedPct(grid) {
        let paved = 0, surfacePlots = 0;
        const singlePathArea = 0.13;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = grid[y][x];
                const z = zoneGrid[y][x];
                if (z.name === 'NONE') continue; // Not part of the site
                surfacePlots++;
                if (p.name === 'WORKSHOP' || p.name === 'SPORT' || p.name === 'EXISTING' || z.name === 'SKELETON') {
                    paved += 1.0;
                } else {
                    // Permeable plot: only its paths count as paved
                    if (p.paths && p.paths.right) paved += singlePathArea;
                    if (p.paths && p.paths.bottom) paved += singlePathArea;
                    if (x > 0 && grid[y][x - 1].paths && grid[y][x - 1].paths.right) paved += singlePathArea;
                    if (y > 0 && grid[y - 1][x].paths && grid[y - 1][x].paths.bottom) paved += singlePathArea;
                }
            }
        }
        return surfacePlots > 0 ? (paved / surfacePlots) * 100 : 0;
    }

    function getDevelopmentChance(x, y) {
        const zone = zoneGrid[y][x];
        const neighbors = getNeighbors(x, y);
        let typesToConsider = ['GREEN', 'FARMING', 'SPORT', 'WORKSHOP'];

        // Rule: Only GREEN can spawn next to AQUEDUCT zone
        if (simulationRules.aqueductGreenOnly && neighbors.AQUEDUCT > 0) {
            typesToConsider = ['GREEN'];
        }
        // Rule: Green Lung — once the paved limit is reached, only unpaved types (Green, Farming) can appear
        else if (greenLungActive) {
            typesToConsider = ['GREEN', 'FARMING'];
        }

        // Shuffle types properly so that checking chance in order is fair
        for (let i = typesToConsider.length - 1; i > 0; i--) {
            const j = Math.floor(nextRandom(x, y) * (i + 1));
            [typesToConsider[i], typesToConsider[j]] = [typesToConsider[j], typesToConsider[i]];
        }

        for (const typeName of typesToConsider) {
            let currentChance = 0;
            if (typeName === 'GREEN') currentChance = simulationParameters.greenSpawnRate;
            else if (typeName === 'FARMING') currentChance = simulationParameters.farmingSpawnRate;
            else if (typeName === 'SPORT') currentChance = simulationParameters.sportSpawnRate;
            else if (typeName === 'WORKSHOP') currentChance = simulationParameters.workshopSpawnRate;

            if (zone.name === typeName) currentChance += simulationParameters.zoneInfluence;
            // Farm plots can spawn on GREEN zone with bonus? Or just base influence?
            // "It can also spawn on green zone" -> Assume Green Zone boosts Farming too?
            // Or maybe separate Farming Zone not implemented yet, so Green Zone is decent place.
            if (typeName === 'FARMING' && zone.name === 'GREEN') currentChance += simulationParameters.zoneInfluence * 0.5; // Half influence from Green Zone

            // Rule: Farming building (Greenhouse) cannot be adjacent to existing.
            // But if rotated away, it divides allowed.
            if (typeName === 'FARMING') {
                // Check if we can place the building (on Green Half) safely away from Existing neighbors
                const layout = getFarmingLayout(x, y);
                let allowedQuads = [];
                // Replicate 'Green Half' logic from drawScene
                if (layout.split === 'X') {
                    if (layout.brownFirst) allowedQuads = [1, 2]; // Green on Right
                    else allowedQuads = [0, 3]; // Green on Left
                } else { // Y
                    if (layout.brownFirst) allowedQuads = [2, 3]; // Green on Bottom
                    else allowedQuads = [0, 1]; // Green on Top
                }

                // Check safety of each allowed quadrant
                const isQuadSafe = (q) => {
                    // Q0: Top (y-1), Left (x-1)
                    // Q1: Top (y-1), Right (x+1)
                    // Q2: Bottom (y+1), Right (x+1)
                    // Q3: Bottom (y+1), Left (x-1)
                    let check = [];
                    if (q === 0) check = [{ dx: 0, dy: -1 }, { dx: -1, dy: 0 }];
                    if (q === 1) check = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }];
                    if (q === 2) check = [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }];
                    if (q === 3) check = [{ dx: 0, dy: 1 }, { dx: -1, dy: 0 }];

                    for (let c of check) {
                        const nx = x + c.dx, ny = y + c.dy;
                        if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                            const n = dataGrid[ny][nx];
                            const z = zoneGrid[ny][nx];
                            if (n.name === 'EXISTING' || z.name === 'EXISTING_HOUSING') return false;
                        }
                    }
                    return true;
                };

                const safeQuads = allowedQuads.filter(isQuadSafe);
                // If NO safe quadrants exist, then we cannot spawn.
                if (safeQuads.length === 0) continue;
            }

            currentChance += neighbors[typeName] * simulationParameters.synergyBonus;

            if (typeName === 'WORKSHOP') {
                // Rule: Workshop plots cannot spawn if existing housing is within 2 plots (radius 2)
                if (simulationRules.workshopDistance && hasExistingNeighbor(x, y, 2)) continue;

                if (simulationRules.workshopRoadBonus && neighbors.SKELETON > 0) {
                    currentChance += simulationParameters.roadBonus;
                }
            }

            if (typeName === 'SPORT') {
                // Rule: Sports can not spawn adjacent to existing housing (radius 1)
                if (simulationRules.sportDistance && hasExistingNeighbor(x, y, 1)) continue;
            }

            // Check Probability
            if (nextRandom(x, y) < currentChance) return typeName;
        }
        return null;
    }

    function getNeighbors(x, y) {
        let counts = { GREEN: 0, FARMING: 0, SPORT: 0, WORKSHOP: 0, EMPTY: 0, SKELETON: 0, EXISTING: 0, AQUEDUCT: 0 };
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dy === 0 && dx === 0) continue;
                const ny = y + dy, nx = x + dx;
                if (ny >= 0 && ny < numRows && nx >= 0 && nx < numCols) {
                    const plotName = dataGrid[ny][nx].name;
                    if (counts[plotName] !== undefined) counts[plotName]++;
                    if (zoneGrid[ny][nx].name === 'SKELETON') counts.SKELETON++;
                    if (zoneGrid[ny][nx].name === 'AQUEDUCT') counts.AQUEDUCT++;
                }
            }
        }
        return counts;
    }

    function hasExistingNeighbor(x, y, radius) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                    if (dataGrid[ny][nx].name === 'EXISTING' || zoneGrid[ny][nx].name === 'EXISTING_HOUSING') {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function calculateTrees() {
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                if (!plot) continue; // Safety check
                const zone = zoneGrid[y][x];
                // Skip empty plots, skeleton zones, existing buildings, and aqueduct zones
                if (plot.name === 'EMPTY' || plot.name === 'EXISTING' || zone.name === 'SKELETON' || zone.name === 'EXISTING_HOUSING' || zone.name === 'AQUEDUCT') continue;

                if (plot.name === 'GREEN') {
                    plot.treeCount += 1;
                    // Ensure minimum 1 tree for Green plots (fix for empty Gardens)
                    plot.treeCount = Math.max(1, plot.treeCount);
                } else if (plot.name === 'SPORT' && plot.variant === 3) {
                    // Tennis Court: No trees allowed.
                    // Try to donate to neighbor, otherwise remove (do nothing).
                    if (simulationRules.treeDonation) {
                        const greenNeighbor = findNearestGreenNeighbor(x, y);
                        if (greenNeighbor) {
                            greenNeighbor.treeCount += 1;
                        }
                    }
                } else if (simulationRules.treeDonation) {
                    const greenNeighbor = findNearestGreenNeighbor(x, y);
                    if (greenNeighbor) {
                        greenNeighbor.treeCount += 1;
                    } else {
                        plot.treeCount += 1;
                    }
                } else {
                    plot.treeCount += 1;
                }
            }
        }
    }

    function findNearestGreenNeighbor(x, y) {
        const neighborOffsets = [
            { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
            { dx: 1, dy: -1 }, { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 }
        ];
        for (let i = 0; i < 8; i++) {
            const nx = x + neighborOffsets[i].dx;
            const ny = y + neighborOffsets[i].dy;
            if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                if (dataGrid[ny][nx].name === 'GREEN') return dataGrid[ny][nx];
            }
        }
        return null;
    }

    function applyScoringRule() {
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                if (plot.name !== 'EMPTY') {
                    // Use dynamic base scores from parameters
                    if (plot.name === 'GREEN') plot.value = simulationParameters.baseScoreGreen;
                    else if (plot.name === 'FARMING') plot.value = simulationParameters.baseScoreFarming;
                    else if (plot.name === 'SPORT') plot.value = simulationParameters.baseScoreSport;
                    else if (plot.name === 'WORKSHOP') plot.value = simulationParameters.baseScoreWorkshop;
                    else plot.value = (plotTypes[plot.name] && plotTypes[plot.name].value) ? plotTypes[plot.name].value : 0;
                }
                else { plot.value = 0; continue; }
                const neighbors = getNeighbors(x, y);
                if (plot.name === 'GREEN') plot.value += (neighbors.GREEN * 0.25);
                else if (plot.name === 'SPORT') plot.value += (neighbors.SPORT * 0.20);
                else if (plot.name === 'WORKSHOP') plot.value += (neighbors.WORKSHOP * 0.15);
                else if (plot.name === 'FARMING') plot.value += (neighbors.FARMING * 0.15); // Add Farming Synergy
            }
        }
    }

    function updateDateDisplay() {
        // Use custom slide animation for main year display
        animateYearOdometerV2(dateDisplay, currentYear, 800);
    }
    // Old updateInfoBox definition removed/replaced above
    // function updateInfoBox(text) { if (infoDisplay) infoDisplay.textContent = text; }

    function updateStatistics() {
        let counts = { GREEN: 0, FARMING: 0, SPORT: 0, WORKSHOP: 0, EMPTY: 0 };
        let activePlots = 0;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = dataGrid[y][x];
                const z = zoneGrid[y][x];
                // Only count active/participating plots (exclude REMOVED, EXISTING, NONE, SKELETON, AQUEDUCT, EXISTING_HOUSING)
                if (p.name === 'REMOVED' || p.name === 'EXISTING' ||
                    z.name === 'NONE' || z.name === 'SKELETON' ||
                    z.name === 'AQUEDUCT' || z.name === 'EXISTING_HOUSING') continue;
                activePlots++;
                const plotName = p.name;
                if (counts[plotName] !== undefined) counts[plotName]++;
            }
        }
        if (activePlots > 0) {
            for (const typeName in counts) {
                const percentage = (counts[typeName] / activePlots) * 100;
                const span = statDisplays[typeName];
                if (span) {
                    // Animate Percentage
                    animateValue(span, percentage, 600, (val) => val.toFixed(2) + "%");

                    const parentDiv = span.parentElement;
                    let color = plotTypes[typeName].color;
                    if (typeName === 'EMPTY') color = '#dddddd';
                    parentDiv.style.background = `linear-gradient(90deg, ${color} ${percentage}%, #ffffff ${percentage}%)`;
                }
            }
        }
    }

    let activeHighlightRule = null;
    let pinnedHighlightRule = null; // Right-click toggled persistent highlight

    // Helper function to get the effective highlight rule (hover takes priority over pinned)
    function getEffectiveHighlightRule() {
        return activeHighlightRule || pinnedHighlightRule;
    }

    function isHighlighted(x, y, plot, zone) {
        // Hover highlight takes priority over pinned highlight
        const effectiveRule = getEffectiveHighlightRule();
        if (!effectiveRule) return false;


        // Safety check for objects
        if (!plot) plot = dataGrid[y][x];
        if (!zone) zone = zoneGrid[y][x];

        switch (effectiveRule) {
            case 'aqueductGreenOnly':
                // Rule: Only GREEN adjacent to AQUEDUCT
                // Highlight: AQUEDUCT zones AND GREEN plots nearby
                // Highlight: AQUEDUCT zones (only if visible/empty) AND GREEN plots nearby
                if (zone.name === 'AQUEDUCT') return plot.name === 'EMPTY';
                if (plot.name === 'GREEN') {
                    // Check neighbors for Aqueduct
                    const n = getNeighbors(x, y);
                    return n.AQUEDUCT > 0;
                }
                return false;

            case 'workshopRoadBonus':
                // Rule: Workshop connected to Skeleton
                // Highlight: SKELETON AND WORKSHOP
                if (zone.name === 'SKELETON') return true;
                if (plot.name === 'WORKSHOP') return true;
                return false;

            case 'workshopDistance': // Industrial Buffer
                // Rule: Workshop cannot be near Existing Housing (Radius 2)
                // Highlight: EXISTING HOUSING and the Buffer Zone (Radius 2)
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;
                if (plot.name === 'WORKSHOP') return true; // Keep Workshops visible
                if (hasExistingNeighbor(x, y, 2)) return true; // Highlight Forbidden Zone
                return false;

            case 'buildingRoadConstraint':
                // Rule: No building on Skeleton; buildings adjacent to roads orient away
                if (zone.name === 'SKELETON') return true;

                // Highlight any plot that HAS a path (paths affect building orientation like roads)
                if (plot.paths && (plot.paths.right || plot.paths.bottom)) {
                    return true;
                }

                // Highlight Workshop/Farming plots adjacent to roads or paths (their orientation follows this rule)
                if (plot.name === 'WORKSHOP' || plot.name === 'FARMING') {
                    // Check if any adjacent tile is a road
                    if (checkIsRoad(x - 1, y) || checkIsRoad(x + 1, y) ||
                        checkIsRoad(x, y - 1) || checkIsRoad(x, y + 1)) {
                        return true;
                    }
                    // Check neighbor's paths affecting this plot (left/top edges)
                    if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) {
                        return true;
                    }
                    if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) {
                        return true;
                    }
                }
                return false;

            case 'sportDistance':
                // Rule: Sport not near Existing (Radius 1)
                // Highlight: EXISTING HOUSING and the Buffer Zone (Radius 1)
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;
                if (plot.name === 'SPORT') return true; // Keep Sport plots visible
                if (hasExistingNeighbor(x, y, 1)) return true; // Highlight Forbidden Zone
                return false;

            case 'farmingNeighbor':
                if (plot.name === 'FARMING') return true;
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;
                return false;

            case 'treeDonation':
                // Highlight RECIPIENTS (Green Plots that potentially received trees)
                if (plot.name === 'GREEN') return true;

                // Highlight DONORS (Non-Green plots that gave their tree away)
                // A plot is a donor if:
                // 1. It is NOT Green/Empty/Existing/Skeleton/Aqueduct
                // 2. It has a valid Green Neighbor to donate to (simulate donation logic)
                if (plot.name !== 'EMPTY' && plot.name !== 'EXISTING' && zone.name !== 'SKELETON' && zone.name !== 'EXISTING_HOUSING' && zone.name !== 'AQUEDUCT') {
                    // Check if a donation target exists (same logic as calculateTrees)
                    if (findNearestGreenNeighbor(x, y)) return true;
                }
                return false;

            case 'doorCreation':
                // Highlight: Existing Buildings AND the plots that triggered them
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;

                const checkDoorTrigger = (cx, cy) => {
                    if (cy > 0 && (dataGrid[cy - 1][cx].name === 'EXISTING' || zoneGrid[cy - 1][cx].name === 'EXISTING_HOUSING') && hasDoor(dataGrid, cx, cy - 1, 'bottom')) return true;
                    if (cy < numRows - 1 && (dataGrid[cy + 1][cx].name === 'EXISTING' || zoneGrid[cy + 1][cx].name === 'EXISTING_HOUSING') && hasDoor(dataGrid, cx, cy + 1, 'top')) return true;
                    if (cx > 0 && (dataGrid[cy][cx - 1].name === 'EXISTING' || zoneGrid[cy][cx - 1].name === 'EXISTING_HOUSING') && hasDoor(dataGrid, cx - 1, cy, 'right')) return true;
                    if (cx < numCols - 1 && (dataGrid[cy][cx + 1].name === 'EXISTING' || zoneGrid[cy][cx + 1].name === 'EXISTING_HOUSING') && hasDoor(dataGrid, cx + 1, cy, 'left')) return true;
                    return false;
                };

                if (checkDoorTrigger(x, y)) return true;
                if (plot.mergedWith && checkDoorTrigger(plot.mergedWith.x, plot.mergedWith.y)) return true;
                return false;

            case 'toppingRule':
                if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') return true;
                return false;
                if (y < numRows - 1 &&
                    (dataGrid[y + 1][x].name === 'EXISTING' || zoneGrid[y + 1][x].name === 'EXISTING_HOUSING') &&
                    hasDoor(dataGrid, x, y + 1, 'top')) return true;

                // Left Neighbor (Door on Right)
                if (x > 0 &&
                    (dataGrid[y][x - 1].name === 'EXISTING' || zoneGrid[y][x - 1].name === 'EXISTING_HOUSING') &&
                    hasDoor(dataGrid, x - 1, y, 'right')) return true;

                // Right Neighbor (Door on Left)
                if (x < numCols - 1 &&
                    (dataGrid[y][x + 1].name === 'EXISTING' || zoneGrid[y][x + 1].name === 'EXISTING_HOUSING') &&
                    hasDoor(dataGrid, x + 1, y, 'left')) return true;

                return false;

                return false;

            case 'greenZoneCompliance':
                // Show green zones and workshops on green zones
                if (zone.name === 'GREEN') return true;
                if (plot.name === 'WORKSHOP') return true;
                return false;

            case 'allowMerging':
                // Highlight all plots that are currently merged
                if (plot.mergedWith) return true;
                return false;

            case 'greenLung':
                // Highlight the unpaved "lung" of the village: all Green and Farming plots
                if (plot.name === 'GREEN' || plot.name === 'FARMING') return true;
                return false;

            default: return false;
        }
    }

    // Helper for Road Checks (Moved to Shared Scope)
    const checkIsRoad = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) return false;
        return zoneGrid[ny][nx].name === 'SKELETON';
    };

    // ============================================================
    // Layout Cache (recomputed only when data changes, not on every render)
    // ============================================================
    function recalcLayoutCaches() {
        if (!layoutsDirty) return;
        if (!dataGrid || !dataGrid.length) return;
        layoutsDirty = false;

        // ---- Pre-calculate sport layouts ----
        sportLayouts = new Map();
        const visitedSport = new Set();
        for (let sy = 0; sy < numRows; sy++) {
            for (let sx = 0; sx < numCols; sx++) {
                const p = dataGrid[sy][sx];
                if (!p || p.name !== 'SPORT') continue;
                if (visitedSport.has(`${sx},${sy}`)) continue;
                if (p.mergedWith && p.isMergeMaster) {
                    let rot = (p.mergedWith.x > sx) ? 0 : 1;
                    sportLayouts.set(`${sx},${sy}`, { variant: 3, rotation: rot });
                    sportLayouts.set(`${p.mergedWith.x},${p.mergedWith.y}`, { variant: 3, rotation: rot + 2 });
                    visitedSport.add(`${sx},${sy}`);
                    visitedSport.add(`${p.mergedWith.x},${p.mergedWith.y}`);
                    continue;
                } else if (p.mergedWith) {
                    visitedSport.add(`${sx},${sy}`); continue;
                }
                const seed = (sx * 492 + sy * 821);
                let rawV = Math.floor(Math.abs(Math.sin(seed) * 1000)) % 3;
                let merged = false;
                if (rawV !== 2) {
                    const ll = sportLayouts.get(`${sx - 1},${sy}`);
                    if (ll && ll.rotation === 2 && ll.variant === rawV) rawV = (rawV + 1) % 3;
                    const tl = sportLayouts.get(`${sx},${sy - 1}`);
                    if (tl && tl.rotation === 3 && tl.variant === rawV) rawV = (rawV + 1) % 3;
                    const rp = (sx + 1 < numCols) ? dataGrid[sy][sx + 1] : null;
                    if (rp && rp.name === 'SPORT' && !rp.mergedWith && !visitedSport.has(`${sx + 1},${sy}`)) {
                        sportLayouts.set(`${sx},${sy}`, { variant: rawV, rotation: 0 });
                        sportLayouts.set(`${sx + 1},${sy}`, { variant: rawV, rotation: 2 });
                        visitedSport.add(`${sx},${sy}`); visitedSport.add(`${sx + 1},${sy}`);
                        merged = true;
                    }
                    if (!merged) {
                        const dp = (sy + 1 < numRows) ? dataGrid[sy + 1][sx] : null;
                        if (dp && dp.name === 'SPORT' && !dp.mergedWith && !visitedSport.has(`${sx},${sy + 1}`)) {
                            sportLayouts.set(`${sx},${sy}`, { variant: rawV, rotation: 1 });
                            sportLayouts.set(`${sx},${sy + 1}`, { variant: rawV, rotation: 3 });
                            visitedSport.add(`${sx},${sy}`); visitedSport.add(`${sx},${sy + 1}`);
                            merged = true;
                        }
                    }
                }
                if (!merged) {
                    const rot = Math.floor(Math.abs(Math.cos(seed) * 1000)) % 4;
                    sportLayouts.set(`${sx},${sy}`, { variant: rawV, rotation: rot });
                    visitedSport.add(`${sx},${sy}`);
                }
            }
        }

        // ---- Pre-calculate workshop layouts ----
        workshopLayouts = new Map();
        for (let wy = 0; wy < numRows; wy++) {
            for (let wx = 0; wx < numCols; wx++) {
                const p = dataGrid[wy][wx];
                if (!p || p.name !== 'WORKSHOP') continue;
                const seed = (wx * 563 + wy * 331);
                let variant = Math.floor(Math.abs(Math.sin(seed) * 1000)) % 3;
                let rotation = Math.floor(Math.abs(Math.cos(seed) * 1000)) % 4;
                if (simulationRules.buildingRoadConstraint) {
                    const vR = checkIsRoad(wx + 1, wy) || (p.paths && p.paths.right);
                    const vB = checkIsRoad(wx, wy + 1) || (p.paths && p.paths.bottom);
                    const vL = checkIsRoad(wx - 1, wy) || (wx > 0 && dataGrid[wy][wx - 1].paths && dataGrid[wy][wx - 1].paths.right);
                    const vT = checkIsRoad(wx, wy - 1) || (wy > 0 && dataGrid[wy - 1][wx].paths && dataGrid[wy - 1][wx].paths.bottom);
                    if (variant === 0 || variant === 2) {
                        if (vR) rotation = 3; else if (vB) rotation = 0;
                        else if (vL) rotation = 1; else if (vT) rotation = 2;
                    } else if (variant === 1) {
                        let best = rotation, maxS = -1;
                        const chk = (r, s) => { if (s > maxS) { maxS = s; best = r; } };
                        chk(0, (vR ? 1 : 0) + (vB ? 1 : 0)); chk(1, (vL ? 1 : 0) + (vB ? 1 : 0));
                        chk(2, (vL ? 1 : 0) + (vT ? 1 : 0)); chk(3, (vR ? 1 : 0) + (vT ? 1 : 0));
                        if (maxS > 0) rotation = best;
                    }
                }
                workshopLayouts.set(`${wx},${wy}`, { variant, rotation });
            }
        }
    }

    // ============================================================
    // PixiJS WORLD BUILDER (replaces drawStaticToCache + drawScene)
    // ============================================================

    // PERFORMANCE: Object pools for PIXI.Container, PIXI.Graphics, and PIXI.Text reuse
    const _containerPool = [];
    const _graphicsPool = [];
    const _textPool = [];

    function _acquireContainer() {
        const c = _containerPool.pop() || new PIXI.Container();
        c.visible = true;
        return c;
    }
    function _releaseContainer(c) {
        // Recursively release all Graphics children back to pool, then clear
        for (let i = 0; i < c.children.length; i++) {
            const ch = c.children[i];
            if (ch instanceof PIXI.Graphics) {
                ch.clear();
                _graphicsPool.push(ch);
            } else if (ch instanceof PIXI.Container) {
                // Recursively release nested containers (e.g. building containers from createFarmingBuilding)
                _releaseContainer(ch);
            }
        }
        c.removeChildren();
        _containerPool.push(c);
    }
    function _acquireGraphics() {
        const g = _graphicsPool.pop() || new PIXI.Graphics();
        return g;
    }
    // Cached text style object — reused across all score text instances
    const _scoreTextStyle = new PIXI.TextStyle({
        fontFamily: 'monospace',
        fontSize: 20, // Will be updated per frame if needed
        fontWeight: 'bold',
        fill: 0x000000,
        align: 'center',
        dropShadow: false,
        padding: 5
    });
    function _acquireText(str, fontSize) {
        const t = _textPool.pop();
        if (t) {
            t.text = str;
            t.style.fontSize = fontSize;
            t.visible = true;
            return t;
        }
        const style = new PIXI.TextStyle({
            fontFamily: 'monospace',
            fontSize: fontSize,
            fontWeight: 'bold',
            fill: 0x000000,
            align: 'center',
            dropShadow: false,
            padding: 5
        });
        return new PIXI.Text(str, style);
    }
    // Helper: release everything that buildWorld() created back to the pools
    function _releaseTileLayers() {
        for (let i = 0; i < groundLayer.children.length; i++) _releaseContainer(groundLayer.children[i]);
        groundLayer.removeChildren();
        for (let i = 0; i < objectLayer.children.length; i++) _releaseContainer(objectLayer.children[i]);
        objectLayer.removeChildren();
    }
    // Helper: release the overlays (drag preview, score texts) that sit on top of the tile layers
    function _releaseOverlays() {
        for (let i = 0; i < worldGrid.children.length; i++) {
            const ch = worldGrid.children[i];
            if (ch === groundLayer || ch === objectLayer) continue;
            // IMPORTANT: Check Graphics BEFORE Container — in Pixi v7, PIXI.Graphics extends PIXI.Container,
            // so instanceof PIXI.Container would also match Graphics objects.
            if (ch instanceof PIXI.Graphics) {
                ch.clear();
                _graphicsPool.push(ch);
            } else if (ch instanceof PIXI.Text) {
                ch.visible = false;
                _textPool.push(ch);
            } else if (ch instanceof PIXI.Container) {
                _releaseContainer(ch);
            }
        }
        worldGrid.removeChildren();
    }
    // Helper: empty a tile container (children go back to the pools) but keep the container itself in place
    function _clearContainer(c) {
        for (let i = 0; i < c.children.length; i++) {
            const ch = c.children[i];
            if (ch instanceof PIXI.Graphics) {
                ch.clear();
                _graphicsPool.push(ch);
            } else if (ch instanceof PIXI.Container) {
                _releaseContainer(ch);
            }
        }
        c.removeChildren();
    }

    // Everything about one plot that influences how it (or a neighbouring tile) is drawn.
    // NOTE: when a drawing function starts using another plot property, add it here.
    function _plotSig(x, y) {
        const p = dataGrid[y][x];
        const m = p.mergedWith, pa = p.paths, fl = p.farmingLayout;
        let lay = null;
        if (p.name === 'SPORT') lay = sportLayouts.get(`${x},${y}`);
        else if (p.name === 'WORKSHOP') lay = workshopLayouts.get(`${x},${y}`);
        return p.name + '|' + p.treeCount + '|' + p.variant + '|' + p.rotation + '|' +
            (m ? m.x + ',' + m.y : '') + '|' + (p.isMergeMaster ? 1 : 0) + '|' + p.occupiedQuad + '|' +
            p.color + '|' + p.scoreColor + '|' + (p.decayStage || 0) + '|' + (p.hasRoofGarden ? 1 : 0) + '|' +
            (pa ? (pa.right ? 1 : 0) + (pa.bottom ? 2 : 0) : 0) + '|' +
            (visualizeScores ? p.value : '') + '|' + (fl ? fl.split + (fl.brownFirst ? 1 : 0) : '') + '|' +
            zoneGrid[y][x].name + '|' + ((freezeGrid[y] && freezeGrid[y][x]) ? 1 : 0) + '|' +
            (lay ? lay.variant + ',' + lay.rotation : '');
    }

    // The part of a plot that the tiles around it read when they are drawn (doors, hedges, slab walls,
    // path gaps, farm orientation). NOTE: extend this when a drawing function reads more from a neighbour.
    function _plotNeighbourSig(x, y) {
        const p = dataGrid[y][x];
        const m = p.mergedWith, pa = p.paths;
        return p.name + '|' + p.color + '|' + (m ? m.x + ',' + m.y : '') + '|' + (p.isMergeMaster ? 1 : 0) + '|' +
            (pa ? (pa.right ? 1 : 0) + (pa.bottom ? 2 : 0) : 0) + '|' + zoneGrid[y][x].name;
    }

    // Path gaps ("squish") of a tile, as used by the 3D-object pass
    function _tileSquish(x, y, plot, rCtx) {
        const sq = { l: 0, r: 0, t: 0, b: 0 };
        const suppressSq = rCtx.effectiveRule && rCtx.effectiveRule !== 'buildingRoadConstraint';
        if (!suppressSq) {
            if (plot.paths) {
                if (plot.paths.right) sq.r = 0.13;
                if (plot.paths.bottom) sq.b = 0.13;
            }
            if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) sq.l = 0.13;
            if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) sq.t = 0.13;
        }
        return sq;
    }

    // Redraw only what changed since the last build: tiles whose plot changed and tiles that scrolled into view.
    // Tiles that are still valid keep their containers. Returns false when a full rebuild is needed.
    function _buildWorldIncremental(rCtx, vr, sigs, nSigs, sr) {
        const old = _lastBuiltRange, oldSr = _lastSigRange;
        if (!old || !oldSr) return false;
        const w = numCols;
        const sameRange = old.startX === vr.startX && old.endX === vr.endX && old.startY === vr.startY && old.endY === vr.endY;

        // 1. Mark the tiles to redraw: a plot that changed, plus the tiles around a plot whose
        //    neighbour-visible part changed (only where both the old and the new signature are known)
        const dirty = new Uint8Array(numCols * numRows);
        let dirtyCount = 0;
        const iy0 = Math.max(sr.y0, oldSr.y0), iy1 = Math.min(sr.y1, oldSr.y1);
        const ix0 = Math.max(sr.x0, oldSr.x0), ix1 = Math.min(sr.x1, oldSr.x1);
        for (let y = iy0; y <= iy1; y++) {
            const row = sigs[y], oldRow = _lastPlotSigs[y], nRow = nSigs[y], oldNRow = _lastNeighbourSigs[y];
            if (!oldRow || !oldNRow) return false;
            for (let x = ix0; x <= ix1; x++) {
                if (nRow[x] !== oldNRow[x]) {
                    const y0 = Math.max(vr.startY, y - INCR_RADIUS), y1 = Math.min(vr.endY, y + INCR_RADIUS);
                    const x0 = Math.max(vr.startX, x - INCR_RADIUS), x1 = Math.min(vr.endX, x + INCR_RADIUS);
                    for (let dy = y0; dy <= y1; dy++) for (let dx = x0; dx <= x1; dx++) {
                        if (!dirty[dy * w + dx]) { dirty[dy * w + dx] = 1; dirtyCount++; }
                    }
                } else if (row[x] !== oldRow[x] && x >= vr.startX && x <= vr.endX && y >= vr.startY && y <= vr.endY) {
                    if (!dirty[y * w + x]) { dirty[y * w + x] = 1; dirtyCount++; }
                }
            }
        }
        if (sameRange && dirtyCount === 0) return true;

        // 2. Check (before touching anything) that enough tiles can be kept and that the kept
        //    containers still match the data
        const isEditMode = rCtx.isEditMode;
        let reusable = 0, total = 0;
        for (let y = vr.startY; y <= vr.endY; y++) {
            const inOldY = y >= old.startY && y <= old.endY;
            for (let x = vr.startX; x <= vr.endX; x++) {
                total++;
                if (!inOldY || x < old.startX || x > old.endX) continue;
                const isRemoved = dataGrid[y][x].name === 'REMOVED';
                // The set of containers no longer matches the data (tile added/removed): rebuild everything
                if (!!gridGraphicRefs[y][x] !== (isEditMode || !isRemoved) || !!objGraphicRefs[y][x] !== !isRemoved) return false;
                if (!dirty[y * w + x]) reusable++;
            }
        }
        // Most of the view changed: a clean rebuild is cheaper than patching
        if (reusable < total * 0.4) return false;

        // 3. Walk the new view in painter's order: keep, redraw or create each tile
        let newGrid = gridGraphicRefs, newObj = objGraphicRefs;
        let groundList = null, objList = null;
        if (!sameRange) {
            newGrid = new Array(numRows);
            newObj = new Array(numRows);
            for (let i = 0; i < numRows; i++) {
                newGrid[i] = new Array(numCols);
                newObj[i] = new Array(numCols);
            }
            groundList = [];
            objList = [];
        }
        for (let y = vr.startY; y <= vr.endY; y++) {
            const inOldY = y >= old.startY && y <= old.endY;
            for (let x = vr.startX; x <= vr.endX; x++) {
                const inOld = inOldY && x >= old.startX && x <= old.endX;
                const redraw = !inOld || dirty[y * w + x];
                if (sameRange && !redraw) continue;
                const plot = dataGrid[y][x];
                const isRemoved = plot.name === 'REMOVED';
                let tile = inOld ? gridGraphicRefs[y][x] : null;
                let objContainer = inOld ? objGraphicRefs[y][x] : null;
                if (isEditMode || !isRemoved) {
                    if (!tile) {
                        tile = _acquireContainer();
                        populateTile(tile, x, y, rCtx);
                    } else if (redraw) {
                        _clearContainer(tile);
                        populateTile(tile, x, y, rCtx);
                    }
                    if (!sameRange) { newGrid[y][x] = tile; groundList.push(tile); }
                }
                if (!isRemoved) {
                    if (!objContainer || redraw) {
                        if (!objContainer) objContainer = _acquireContainer(); else _clearContainer(objContainer);
                        addTileObjects(objContainer, x, y, isoToScreen(x, y), plot, zoneGrid[y][x], _tileSquish(x, y, plot, rCtx), rCtx);
                        objContainer.visible = objContainer.children.length > 0;
                    }
                    if (!sameRange) { newObj[y][x] = objContainer; objList.push(objContainer); }
                }
            }
        }

        // 4. The view moved: drop the tiles that scrolled out and put the layers back in painter's order
        if (!sameRange) {
            groundLayer.removeChildren();
            objectLayer.removeChildren();
            for (let y = old.startY; y <= old.endY; y++) {
                const inNewY = y >= vr.startY && y <= vr.endY;
                for (let x = old.startX; x <= old.endX; x++) {
                    if (inNewY && x >= vr.startX && x <= vr.endX) continue;
                    if (gridGraphicRefs[y][x]) _releaseContainer(gridGraphicRefs[y][x]);
                    if (objGraphicRefs[y][x]) _releaseContainer(objGraphicRefs[y][x]);
                }
            }
            for (let i = 0; i < groundList.length; i++) groundLayer.addChild(groundList[i]);
            for (let i = 0; i < objList.length; i++) objectLayer.addChild(objList[i]);
            gridGraphicRefs = newGrid;
            objGraphicRefs = newObj;
        }
        return true;
    }

    function buildWorld(forceNoCull = false, allowIncremental = false) {
        uiLayer.removeChildren();
        if (!dataGrid || !dataGrid.length) {
            _releaseTileLayers();
            _releaseOverlays();
            gridGraphicRefs = new Array(numRows);
            for (let i = 0; i < numRows; i++) gridGraphicRefs[i] = new Array(numCols);
            _lastPlotSigs = null;
            _lastNeighbourSigs = null;
            _lastCtxKey = null;
            _lastSigRange = null;
            return;
        }

        const isDark = document.body.classList.contains('dark-mode');
        const gridAlpha = isDark ? 0.12 : (showShadows ? 0.12 : 0.4);
        const gridStrokeHex = isDark ? 0xFFFFFF : 0x000000;
        const emptyHex = isDark ? 0x374151 : 0xFFFFFF;
        const renderShadows = showShadows && !isInteracting && currentLOD === 0;
        const showOutlines = !showShadows; // Outlines only when user explicitly disabled shadows (NOT during interaction)
        const isEditMode = currentMode === 'draw';

        // Recompute layout caches only if data changed (skips during zoom/pan)
        recalcLayoutCaches();

        // ---- Render context passed to per-tile functions ----
        const effectiveRule = getEffectiveHighlightRule();
        const rCtx = { isDark, gridAlpha, gridStrokeHex, emptyHex, renderShadows, showOutlines, isEditMode, effectiveRule, lod: currentLOD };

        // ---- Viewport culling: compute visible tile range ----
        const vr = forceNoCull ? { startX: 0, endX: numCols - 1, startY: 0, endY: numRows - 1 } : getVisibleTileRange();

        // ---- Incremental rendering: what would this build draw, compared to what is on screen? ----
        let sigs = null, nSigs = null, ctxKey = null, sr = null, incrementalDone = false;
        if (INCREMENTAL_RENDER && !forceNoCull) {
            ctxKey = [numCols, numRows, isDark, showShadows, renderShadows, isEditMode,
                currentLOD, showObjects, visualizeScores, tileWidth, tileHeight,
                JSON.stringify(simulationRules), JSON.stringify(simulationParameters)].join('|');
            sr = {
                x0: Math.max(0, vr.startX - INCR_RADIUS), x1: Math.min(numCols - 1, vr.endX + INCR_RADIUS),
                y0: Math.max(0, vr.startY - INCR_RADIUS), y1: Math.min(numRows - 1, vr.endY + INCR_RADIUS)
            };
            sigs = new Array(numRows);
            nSigs = new Array(numRows);
            for (let y = sr.y0; y <= sr.y1; y++) {
                const row = sigs[y] = new Array(numCols);
                const nRow = nSigs[y] = new Array(numCols);
                for (let x = sr.x0; x <= sr.x1; x++) {
                    row[x] = _plotSig(x, y);
                    nRow[x] = _plotNeighbourSig(x, y);
                }
            }
            if (allowIncremental && !fullRebuildNeeded && !effectiveRule && _lastPlotSigs && _lastNeighbourSigs && ctxKey === _lastCtxKey) {
                incrementalDone = _buildWorldIncremental(rCtx, vr, sigs, nSigs, sr);
            }
        }

        if (!incrementalDone) {
            _releaseTileLayers();
            gridGraphicRefs = new Array(numRows);
            objGraphicRefs = new Array(numRows);
            for (let i = 0; i < numRows; i++) {
                gridGraphicRefs[i] = new Array(numCols);
                objGraphicRefs[i] = new Array(numCols);
            }

            // ---- Build tile grid (Y then X for painter's algorithm) ----
            // PASS 1: Ground tiles, paths, sport markings
            for (let y = vr.startY; y <= vr.endY; y++) {
                for (let x = vr.startX; x <= vr.endX; x++) {
                    // PERFORMANCE: REMOVED plots draw nothing. While simulating, skip their (empty) container.
                    // (In edit mode the container is kept so updateTile() can redraw it instantly when painting.)
                    if (!isEditMode && dataGrid[y][x].name === 'REMOVED') continue;
                    const tile = _acquireContainer();
                    populateTile(tile, x, y, rCtx);
                    groundLayer.addChild(tile);
                    gridGraphicRefs[y][x] = tile;
                }
            }

            // HIGHLIGHT: Now handled directly in populateTile() - non-highlighted tiles render as empty grid
            // PASS 2: 3D objects (buildings, trees, sport items) + shadows
            // Rendered AFTER all ground tiles so shadows appear on top of neighboring plots
            for (let y = vr.startY; y <= vr.endY; y++) {
                for (let x = vr.startX; x <= vr.endX; x++) {
                    const plot = dataGrid[y][x];
                    if (plot.name === 'REMOVED') continue; // PERFORMANCE: addTileObjects() draws nothing for these
                    const objContainer = _acquireContainer();
                    addTileObjects(objContainer, x, y, isoToScreen(x, y), plot, zoneGrid[y][x], _tileSquish(x, y, plot, rCtx), rCtx);
                    // PERFORMANCE: tiles without 3D objects stay in the layer (so they can be filled later) but are not rendered
                    objContainer.visible = objContainer.children.length > 0;
                    objectLayer.addChild(objContainer);
                    objGraphicRefs[y][x] = objContainer;
                }
            }
        }

        // ---- Overlays are rebuilt on every build, on top of the tile layers ----
        _releaseOverlays();
        worldGrid.addChild(groundLayer);
        worldGrid.addChild(objectLayer);

        // RECTANGLE DRAG PREVIEW: Draw selection rectangle
        if (dragRectStart && dragRectEnd) {
            const fx0 = Math.min(dragRectStart.x, dragRectEnd.x);
            const fx1 = Math.max(dragRectStart.x, dragRectEnd.x);
            const fy0 = Math.min(dragRectStart.y, dragRectEnd.y);
            const fy1 = Math.max(dragRectStart.y, dragRectEnd.y);
            const previewG = _acquireGraphics();
            
            let previewColor = 0x2196F3; // Default blue for freeze
            if (!freezeToolActive && currentBrush && currentBrush.name && paletteColors[currentBrush.name]) {
                previewColor = parseInt(paletteColors[currentBrush.name].replace('#', '0x'), 16) || 0x2196F3;
            } else if (!freezeToolActive && currentMode === 'erase') {
                previewColor = 0xFF0000; // Red for erase
            }

            for (let py = fy0; py <= fy1; py++) {
                for (let px = fx0; px <= fx1; px++) {
                    if (px >= 0 && px < numCols && py >= 0 && py < numRows) {
                        const pSp = isoToScreen(px, py);
                        drawIsoTileG(previewG, pSp.x, pSp.y, tileWidth, tileHeight, previewColor, 0.25, previewColor, 0.6, { l: 0, r: 0, t: 0, b: 0 }, 2);
                    }
                }
            }
            previewG.zIndex = 8000;
            worldGrid.addChild(previewG);
        }

        // PASS 3: Score overlay (if enabled) — skip at LOD 2 (unreadable)
        if (showScores && !isEditMode && currentLOD < 2) {
            const fontSize = Math.max(6, Math.round(tileHeight / 3));
            for (let y = vr.startY; y <= vr.endY; y++) {
                for (let x = vr.startX; x <= vr.endX; x++) {
                    const plot = dataGrid[y][x];
                    const zone = zoneGrid[y][x];
                    if (plot.value > 0 && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {
                        const sp = isoToScreen(x, y);
                        // High-Res Text for sharpness (pooled)
                        const scoreText = _acquireText(plot.value.toFixed(2), fontSize * 2);
                        scoreText.anchor.set(0.5, 0.5);
                        scoreText.scale.set(0.5); // Scale down to original size
                        scoreText.x = sp.x;
                        scoreText.y = sp.y + tileHeight / 2;
                        worldGrid.addChild(scoreText);
                    }
                }
            }
        }

        // Remember what is on screen for the next (incremental) build
        _lastPlotSigs = sigs;
        _lastNeighbourSigs = nSigs;
        _lastCtxKey = ctxKey;
        _lastSigRange = sr;
        _lastBuiltRange = vr;
        fullRebuildNeeded = false;

        // Store visible range for culling change detection
        lastVisibleRange = vr;
    }

    // ---- Per-tile rendering ----
    function populateTile(tile, x, y, rCtx) {
        const plot = dataGrid[y][x];
        const zone = zoneGrid[y][x];

        if (plot && plot.name === 'REMOVED') return;

        // MIGRATION: Removed (Reverting to original colors)
        const sp = isoToScreen(x, y);

        // Rule highlight: check if this tile is highlighted
        let isHigh = false;
        if (rCtx.effectiveRule) {
            isHigh = isHighlighted(x, y, plot, zone);
        }
        // Store for pass 2 (3D objects)
        plot._cachedHighlight = isHigh;

        // Squish (path gaps) - suppress when a rule highlight is active (except rightOfWay)
        let sq = { l: 0, r: 0, t: 0, b: 0 };
        const suppressSquish = rCtx.effectiveRule && rCtx.effectiveRule !== 'buildingRoadConstraint';
        if (!suppressSquish) {
            if (plot.paths) {
                if (plot.paths.right) sq.r = 0.13;
                if (plot.paths.bottom) sq.b = 0.13;
            }
            if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) sq.l = 0.13;
            if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) sq.t = 0.13;
        }

        // editSq is used for ground tile rendering only — kept empty so no grey gap appears
        // sq (with actual squish values) is still used by addPaths() and passed to Pass 2 for 3D objects
        const editSq = { l: 0, r: 0, t: 0, b: 0 };

        // ==== GROUND TILE ====
        const g = _acquireGraphics();

        // ---- Draw per-tile slab walls ----
        if (showSlab) {
            const slT = tileHeight * 0.75;
            const topC = { x: sp.x, y: sp.y }; 
            const rightC = { x: sp.x + tileWidth / 2, y: sp.y + tileHeight / 2 };
            const bottomC = { x: sp.x, y: sp.y + tileHeight };
            const leftC = { x: sp.x - tileWidth / 2, y: sp.y + tileHeight / 2 };
            
            // Bottom-left wall (faces screen bottom-left)
            if (y === numRows - 1 || (dataGrid[y + 1] && dataGrid[y + 1][x] && dataGrid[y + 1][x].name === 'REMOVED')) {
                g.beginFill(0xD3D3D3);
                g.drawPolygon([leftC.x, leftC.y, bottomC.x, bottomC.y, bottomC.x, bottomC.y + slT, leftC.x, leftC.y + slT]);
                g.endFill();
                if (rCtx.showOutlines) {
                    g.lineStyle(1, 0x000000, 0.8);
                    g.moveTo(leftC.x, leftC.y + slT);
                    g.lineTo(bottomC.x, bottomC.y + slT);
                    g.lineTo(bottomC.x, bottomC.y);
                    g.lineStyle(0);
                }
            }
            // Bottom-right wall (faces screen bottom-right)
            if (x === numCols - 1 || (dataGrid[y] && dataGrid[y][x + 1] && dataGrid[y][x + 1].name === 'REMOVED')) {
                g.beginFill(0xA9A9A9);
                g.drawPolygon([bottomC.x, bottomC.y, rightC.x, rightC.y, rightC.x, rightC.y + slT, bottomC.x, bottomC.y + slT]);
                g.endFill();
                if (rCtx.showOutlines) {
                    g.lineStyle(1, 0x000000, 0.8);
                    g.moveTo(bottomC.x, bottomC.y + slT);
                    g.lineTo(rightC.x, rightC.y + slT);
                    g.lineTo(rightC.x, rightC.y);
                    g.lineStyle(0);
                }
            }
            // Top/Left outlines to seal the grid
            if (rCtx.showOutlines) {
                if (y === 0 || (dataGrid[y - 1] && dataGrid[y - 1][x] && dataGrid[y - 1][x].name === 'REMOVED')) {
                    g.lineStyle(1, 0x000000, 0.8);
                    g.moveTo(leftC.x, leftC.y);
                    g.lineTo(topC.x, topC.y);
                    g.lineStyle(0);
                }
                if (x === 0 || (dataGrid[y] && dataGrid[y][x - 1] && dataGrid[y][x - 1].name === 'REMOVED')) {
                    g.lineStyle(1, 0x000000, 0.8);
                    g.moveTo(topC.x, topC.y);
                    g.lineTo(rightC.x, rightC.y);
                    g.lineStyle(0);
                }
            }
        }

        // Simplified view: When showObjects is off, render flat zone-colored tiles only
        if (!showObjects && !rCtx.isEditMode) {
            let zoneHex = rCtx.emptyHex;
            let zoneAlpha = 1;
            let needOverlay = false;

            // Use zone color for the ground
            if (zone.name === 'SKELETON') {
                zoneHex = cssToHex(zone.color);
            } else if (zone.name === 'AQUEDUCT') {
                zoneHex = cssToHex(zone.color);
                zoneAlpha = cssAlpha(zone.color);
                needOverlay = true;
            } else if (zone.name === 'EXISTING_HOUSING') {
                zoneHex = cssToHex(zone.color);
                zoneAlpha = cssAlpha(zone.color);
                needOverlay = true;
            } else if (zone.name !== 'NEUTRAL' && zone.color) {
                zoneHex = cssToHex(zone.color);
                zoneAlpha = cssAlpha(zone.color);
                needOverlay = true;
            }

            // Override with plot color for occupied plots (to show what's built)
            if (plot.name === 'GREEN') { zoneHex = cssToHex(plotTypes.GREEN.color); needOverlay = false; zoneAlpha = 1; }
            else if (plot.name === 'SPORT') { zoneHex = cssToHex(plotTypes.SPORT.color); needOverlay = false; zoneAlpha = 1; }
            else if (plot.name === 'WORKSHOP') { zoneHex = cssToHex(plotTypes.WORKSHOP.color); needOverlay = false; zoneAlpha = 1; }
            else if (plot.name === 'FARMING') { zoneHex = 0xE6DEC8; needOverlay = false; zoneAlpha = 1; }
            else if (plot.name === 'EXISTING') { zoneHex = cssToHex(plotTypes.EXISTING.color); needOverlay = false; zoneAlpha = 1; }
            else if (zone.name === 'EXISTING_HOUSING') { zoneHex = 0xFFFFFF; needOverlay = false; zoneAlpha = 1; }

            // Apply heatmap darkening if enabled
            if (visualizeScores && plot.name !== 'EMPTY' && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {
                let baseVal = 0;
                if (plot.name === 'GREEN') baseVal = simulationParameters.baseScoreGreen;
                else if (plot.name === 'SPORT') baseVal = simulationParameters.baseScoreSport;
                else if (plot.name === 'WORKSHOP') baseVal = simulationParameters.baseScoreWorkshop;
                else if (plot.name === 'FARMING') baseVal = simulationParameters.baseScoreFarming || 1.3;
                else baseVal = plotTypes[plot.name]?.value || 0;

                const delta = Math.max(0, (plot.value || 0) - baseVal);
                const intensity = Math.min(0.7, delta * 0.25);
                if (intensity > 0) {
                    let targetHex = 0x2F4F4F;
                    if (plot.name === 'WORKSHOP') targetHex = 0x8B4513;
                    else if (plot.name === 'GREEN') targetHex = 0x1B4332;
                    else if (plot.name === 'SPORT') targetHex = 0x154360;
                    else if (plot.name === 'FARMING') targetHex = 0x3B5323;

                    const r1 = (zoneHex >> 16) & 0xFF, g1 = (zoneHex >> 8) & 0xFF, b1 = zoneHex & 0xFF;
                    const r2 = (targetHex >> 16) & 0xFF, g2 = (targetHex >> 8) & 0xFF, b2 = targetHex & 0xFF;
                    const r = Math.round(r1 + (r2 - r1) * intensity);
                    const gC = Math.round(g1 + (g2 - g1) * intensity);
                    const b = Math.round(b1 + (b2 - b1) * intensity);
                    zoneHex = (r << 16) | (gC << 8) | b;
                    needOverlay = false;
                    zoneAlpha = 1;
                }
            }

            if (needOverlay && plot.name === 'EMPTY') {
                // White base + zone color overlay (same approach as zone overlays)
                drawIsoTileG(g, sp.x, sp.y, tileWidth, tileHeight, rCtx.emptyHex, 1, rCtx.gridStrokeHex, rCtx.gridAlpha, { l: 0, r: 0, t: 0, b: 0 }, 1.5);
                const zG = _acquireGraphics();
                drawIsoTileG(zG, sp.x, sp.y, tileWidth, tileHeight, zoneHex, zoneAlpha, 0, 0, { l: 0, r: 0, t: 0, b: 0 }, 0);
                tile.addChild(g);
                tile.addChild(zG);
            } else {
                drawIsoTileG(g, sp.x, sp.y, tileWidth, tileHeight, zoneHex, 1, rCtx.gridStrokeHex, rCtx.gridAlpha, { l: 0, r: 0, t: 0, b: 0 }, 1.5);
                tile.addChild(g);
            }
            // Freeze overlay in simplified view
            if (freezeGrid[y] && freezeGrid[y][x]) {
                const fG = _acquireGraphics();
                drawIsoTileG(fG, sp.x, sp.y, tileWidth, tileHeight, 0x2196F3, 0.15, 0x2196F3, 0.4, { l: 0, r: 0, t: 0, b: 0 }, 1.5);
                tile.addChild(fG);
            }
            return; // Skip all paths, sport markings, details
        }

        // Rule dimming: if a rule is active and this tile is NOT highlighted, render as empty grid
        // Only draw paths if rightOfWay rule is active
        if (rCtx.effectiveRule && !isHigh) {
            drawIsoTileG(g, sp.x, sp.y, tileWidth, tileHeight, rCtx.emptyHex, 1, rCtx.gridStrokeHex, rCtx.gridAlpha, editSq, 1.5);
            tile.addChild(g);
            if (rCtx.effectiveRule === 'buildingRoadConstraint') {
                addPaths(tile, x, y, sp, sq, rCtx);
            }
            // Freeze overlay in rule dimming view
            if (freezeGrid[y] && freezeGrid[y][x]) {
                const fG = _acquireGraphics();
                drawIsoTileG(fG, sp.x, sp.y, tileWidth, tileHeight, 0x2196F3, 0.15, 0x2196F3, 0.4, editSq, 1.5);
                tile.addChild(fG);
            }
            return; // Skip zone colors, sport markings — just show empty grid
        }

        // Single farming: split tile (special rendering)
        // MODIFY: Suppress in Industrial Buffer View
        let suppressInIndBuffer = false;
        if (rCtx.effectiveRule === 'workshopDistance') {
            const isExisting = (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY'));
            const isWorkshop = (plot.name === 'WORKSHOP');
            if (!isExisting && !isWorkshop) suppressInIndBuffer = true;
        }
        if (rCtx.effectiveRule === 'sportDistance') {
            const isExisting = (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY'));
            const isSport = (plot.name === 'SPORT');
            if (!isExisting && !isSport) suppressInIndBuffer = true;
        }
        if (rCtx.effectiveRule === 'greenZoneCompliance' && zone.name === 'GREEN' && plot.name !== 'WORKSHOP') {
            suppressInIndBuffer = true;
        }

        if (plot.name === 'FARMING' && !plot.mergedWith && !rCtx.isEditMode && !suppressInIndBuffer) {
            drawFarmingSplitTile(g, x, y, sp, plot, rCtx);
            tile.addChild(g);
            if (!rCtx.effectiveRule || rCtx.effectiveRule === 'buildingRoadConstraint') {
                addPaths(tile, x, y, sp, sq, rCtx);
            }
            // 3D objects added in pass 2
            return;
        }

        // Determine fill color
        let fillHex = rCtx.emptyHex;
        let fillAlpha = 1;
        let isZoneOverlay = false;

        if (rCtx.isEditMode) {
            // == EDIT MODE ==
            // Requirement: "Base = Zone Color, Top = Plot Dot"
            // 1. Base Color = Zone Color
            if (zone.name !== 'NEUTRAL' && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT' && zone.color) {
                fillHex = cssToHex(zone.color);
                fillAlpha = cssAlpha(zone.color);
                isZoneOverlay = true;
            } else if (zone.name === 'SKELETON') {
                fillHex = cssToHex(zone.color);
            } else if (zone.name === 'AQUEDUCT') {
                fillHex = cssToHex(zone.color);
                fillAlpha = cssAlpha(zone.color);
                isZoneOverlay = true;
            }

            // Overrides for Edit Mode
            if (plot.name === 'EXISTING') {
                fillHex = cssToHex(plotTypes.EXISTING.color);
                isZoneOverlay = false;
            } else if (zone.name === 'EXISTING_HOUSING') {
                fillHex = 0xFFFFFF;
                isZoneOverlay = false;
            }
        } else {
            // == SIMULATION MODE ==
            // Requirement: "Base = Plot Color (Full Tile). NO Dot."
            // Priority: Plot Color > Zone Color
            if (plot.name === 'FARMING' && plot.mergedWith) fillHex = 0x52B788;
            else if (plot.name === 'WORKSHOP' && plot.mergedWith) fillHex = 0xFFE0B2;
            else if (plot.name === 'GREEN') {
                if (plot.mergedWith) fillHex = 0xB5E8C4; // Zeer licht grasgroen voor merged park
                else fillHex = cssToHex(plotTypes.GREEN.color);
            }
            else if (plot.name === 'SPORT') {
                // Tennis court (merged variant 3) gets orange tarmac color
                if (plot.mergedWith && plot.variant === 3) {
                    fillHex = 0xE8884F; // Orange tarmac
                } else {
                    fillHex = cssToHex(plotTypes.SPORT.color);
                }
            }
            else if (plot.name === 'WORKSHOP') fillHex = cssToHex(plotTypes.WORKSHOP.color);
            else if (plot.name === 'FARMING') fillHex = 0xE6DEC8;
            else if (plot.name === 'EXISTING') fillHex = cssToHex(plotTypes.EXISTING.color);
            else if (zone.name === 'EXISTING_HOUSING') fillHex = 0xFFFFFF;
            // Fallback to Zone if Plot is Empty/Neutral
            else if (zone.name === 'SKELETON') fillHex = cssToHex(zone.color);
            else if (zone.name === 'AQUEDUCT') { fillHex = cssToHex(zone.color); fillAlpha = cssAlpha(zone.color); isZoneOverlay = true; }
            else if (zone.name !== 'NEUTRAL' && zone.color) { fillHex = cssToHex(zone.color); fillAlpha = cssAlpha(zone.color); isZoneOverlay = true; }
        }

        // Merged plots might keep their specific ground color or fallback to zone?
        // Let's keep specific ground for Merged to ensure they look like a coherent unit if needed,
        // but User asked for Zone Visibility.
        // Let's stick to Zone Color for ground unless it's Existing.
        // (Removed previous plot.name checks that obscured zone)

        // Rule highlight brightening
        if (rCtx.effectiveRule && isHigh) {
            // Buffer zone amber color
            if ((rCtx.effectiveRule === 'workshopDistance' && hasExistingNeighbor(x, y, 2)) ||
                (rCtx.effectiveRule === 'sportDistance' && hasExistingNeighbor(x, y, 1))) {
                fillHex = 0xFFAB00; // Amber
                fillAlpha = 1;
                isZoneOverlay = false;
            }
            // Green Zone Compliance: show zone color for non-workshop plots on green zones
            if (rCtx.effectiveRule === 'greenZoneCompliance' && zone.name === 'GREEN' && plot.name !== 'WORKSHOP') {
                fillHex = cssToHex(zone.color);
                fillAlpha = cssAlpha(zone.color);
                isZoneOverlay = true;
            }
        }

        // Sustainability heatmap: darken tiles based on score intensity
        if (visualizeScores && !rCtx.isEditMode && plot.name !== 'EMPTY' && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {
            let baseVal = 0;
            if (plot.name === 'GREEN') baseVal = simulationParameters.baseScoreGreen;
            else if (plot.name === 'SPORT') baseVal = simulationParameters.baseScoreSport;
            else if (plot.name === 'WORKSHOP') baseVal = simulationParameters.baseScoreWorkshop;
            else if (plot.name === 'FARMING') baseVal = simulationParameters.baseScoreFarming || 1.3;
            else baseVal = plotTypes[plot.name]?.value || 0;

            const delta = Math.max(0, (plot.value || 0) - baseVal);
            const intensity = Math.min(0.7, delta * 0.25);

            if (intensity > 0) {
                // Determine target dark color per type
                let targetHex = 0x2F4F4F; // Default dark teal
                if (plot.name === 'WORKSHOP') targetHex = 0x8B4513;
                else if (plot.name === 'GREEN') targetHex = 0x1B4332;
                else if (plot.name === 'SPORT') targetHex = 0x154360;
                else if (plot.name === 'FARMING') targetHex = 0x3B5323;

                // Lerp between fillHex and targetHex by intensity
                const r1 = (fillHex >> 16) & 0xFF, g1 = (fillHex >> 8) & 0xFF, b1 = fillHex & 0xFF;
                const r2 = (targetHex >> 16) & 0xFF, g2 = (targetHex >> 8) & 0xFF, b2 = targetHex & 0xFF;
                const r = Math.round(r1 + (r2 - r1) * intensity);
                const gC = Math.round(g1 + (g2 - g1) * intensity);
                const b = Math.round(b1 + (b2 - b1) * intensity);
                fillHex = (r << 16) | (gC << 8) | b;
                fillAlpha = 1;
                isZoneOverlay = false;
            }
        }

        // Decay darkening
        if ((plot.decayStage || 0) > 0) {
            const dHex = '#' + fillHex.toString(16).padStart(6, '0');
            fillHex = cssToHex(darkenColor(dHex, 35));
        }

        if (isZoneOverlay) {
            // Two-layer draw: white base + zone color with alpha (matches Canvas 2D rgba behavior)
            drawIsoTileG(g, sp.x, sp.y, tileWidth, tileHeight, rCtx.emptyHex, 1, rCtx.gridStrokeHex, rCtx.gridAlpha, editSq, 1.5);
            const zoneG = _acquireGraphics();
            drawIsoTileG(zoneG, sp.x, sp.y, tileWidth, tileHeight, fillHex, fillAlpha, 0, 0, editSq, 0);
            tile.addChild(g);
            tile.addChild(zoneG);
        } else {
            drawIsoTileG(g, sp.x, sp.y, tileWidth, tileHeight, fillHex, 1, rCtx.gridStrokeHex, rCtx.gridAlpha, editSq, 1.5);
            tile.addChild(g);
        }

        // ==== PLOT DOT RENDERING (Saturated Center) ====
        // User Requirement: "Plots to appear as saturated dots in the middle, allowing zone color to remain visible"
        // Applied in Edit Mode (Essential) AND Simulation Mode (Consistency)
        // MODIFY: Also suppress dots in Industrial Buffer View
        // ==== PLOT DOT RENDERING (Saturated Center) ====
        // Requirement: "Edit Mode: DOTS. Simulation Mode: FULL PLOTS (No Dots)"
        // Condition: Must be Edit Mode OR (Existing/Special cases?)
        // Actually user said: "changing the plots to dots for edit mode you also changed them to dots in simulation mode... You need to seperate it"
        // So ONLY draw dots in Edit Mode (or if it's Existing? Existing usually stays consistent).
        // Let's keep Existing behavior consistent (White tile + Grey Dot?), or just White Tile.
        // Let's assume User wants DOTS only in Edit Mode for the "Plot Types" (Green, Sport, Workshop, Farming).

        if (rCtx.isEditMode && plot.name !== 'EMPTY' && plot.name !== 'EXISTING' && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT' && !suppressInIndBuffer) {
            let dotHex = rCtx.emptyHex;
            if (plot.name === 'GREEN') dotHex = cssToHex(plotTypes.GREEN.color);
            else if (plot.name === 'SPORT') dotHex = cssToHex(plotTypes.SPORT.color);
            else if (plot.name === 'WORKSHOP') dotHex = cssToHex(plotTypes.WORKSHOP.color);
            else if (plot.name === 'FARMING') dotHex = cssToHex(plotTypes.FARMING.color);
            // else if (plot.name === 'EXISTING') dotHex = 0xE5E5E5; // Existing doesn't need a dot if it's already white?

            // Decay darkening for Dot
            if ((plot.decayStage || 0) > 0) {
                const dHexStr = '#' + dotHex.toString(16).padStart(6, '0');
                dotHex = cssToHex(darkenColor(dHexStr, 35));
            }

            // Draw a 0.6 scale diamond "dot" on top of the zone color
            const dotG = _acquireGraphics();
            drawIsoTileG(dotG, sp.x, sp.y, tileWidth, tileHeight, dotHex, 1, 0, 0, editSq, 0, 0.6);
            tile.addChild(dotG);
        } else if (rCtx.isEditMode && plot.name === 'EXISTING') {
            // Keep the Existing Dot for consistency in Edit Mode?
            const dotHex = 0xE5E5E5;
            const dotG = _acquireGraphics();
            drawIsoTileG(dotG, sp.x, sp.y, tileWidth, tileHeight, dotHex, 1, 0, 0, editSq, 0, 1.0); // Full scale?
            // Actually, user liked the "Dots" in edit mode. existing is usually just white.
            tile.addChild(dotG);
        }

        // ==== FREEZE OVERLAY ====
        if (freezeGrid[y] && freezeGrid[y][x]) {
            const fG = _acquireGraphics();
            drawIsoTileG(fG, sp.x, sp.y, tileWidth, tileHeight, 0x2196F3, 0.15, 0x2196F3, 0.4, editSq, 1.5);
            tile.addChild(fG);
        }

        // ==== PATHS (only if no rule active, or rightOfWay rule) ====
        if (!rCtx.effectiveRule || rCtx.effectiveRule === 'buildingRoadConstraint') {
            addPaths(tile, x, y, sp, sq, rCtx);
        }

        // ==== SPORT GROUND MARKINGS (flat, before 3D objects) ====
        if (plot.name === 'SPORT' && !rCtx.isEditMode && rCtx.effectiveRule !== 'greenZoneCompliance') {
            const lay = sportLayouts.get(`${x},${y}`);
            const sg = _acquireGraphics();
            addSportGround(sg, sp.x, sp.y, tileWidth, tileHeight, lay ? lay.variant : 0, lay ? lay.rotation : 0, sq);
            tile.addChild(sg);
        }

        // ==== 3D OBJECTS added in pass 2 (after all ground tiles) ====
    }

    // ---- Farming split tile (green/brown halves) ----
    function drawFarmingSplitTile(g, x, y, sp, plot, rCtx) {
        let layout = { split: 'X', brownFirst: true };
        if (typeof getFarmingLayout === 'function') layout = getFarmingLayout(x, y);
        let bH = 0xA18D70, gH = 0x52B788;
        if ((plot.decayStage || 0) > 0) {
            bH = cssToHex(darkenColor('#A18D70', 35));
            gH = cssToHex(darkenColor('#52B788', 35));
        }
        const tw = tileWidth, th = tileHeight;
        const tw2 = tw / 2, th2 = th / 2, tw4 = tw / 4, th4 = th / 4;
        const c1 = layout.brownFirst ? bH : gH, c2 = layout.brownFirst ? gH : bH;
        if (layout.split === 'X') {
            g.beginFill(c1);
            g.drawPolygon([sp.x, sp.y, sp.x + tw4, sp.y + th4, sp.x - tw4, sp.y + 3 * th4, sp.x - tw2, sp.y + th2]);
            g.endFill();
            g.beginFill(c2);
            g.drawPolygon([sp.x + tw4, sp.y + th4, sp.x + tw2, sp.y + th2, sp.x, sp.y + th, sp.x - tw4, sp.y + 3 * th4]);
            g.endFill();
        } else {
            g.beginFill(c1);
            g.drawPolygon([sp.x, sp.y, sp.x + tw2, sp.y + th2, sp.x + tw4, sp.y + 3 * th4, sp.x - tw4, sp.y + th4]);
            g.endFill();
            g.beginFill(c2);
            g.drawPolygon([sp.x - tw4, sp.y + th4, sp.x + tw4, sp.y + 3 * th4, sp.x, sp.y + th, sp.x - tw2, sp.y + th2]);
            g.endFill();
        }
        g.lineStyle(0.5, rCtx.gridStrokeHex, rCtx.gridAlpha);
        g.drawPolygon([sp.x, sp.y, sp.x + tw2, sp.y + th2, sp.x, sp.y + th, sp.x - tw2, sp.y + th2]);
        g.lineStyle(0);
    }

    // ---- Path lines between tiles (Flat Edge Strips using UV coords) ----
    function addPaths(tile, x, y, sp, sq, rCtx) {
        const plot = dataGrid[y][x];
        if (!plot.paths) return;
        const pg = _acquireGraphics();
        const pathColor = 0xC4A882; // Lichter zandbruin

        pg.beginFill(pathColor, 1.0);

        // Use the SAME coordinate system as drawIsoTileG:
        // gx(u,v) = sp.x + u * hW - v * hW
        // gy(u,v) = sp.y + u * hH + v * hH
        const hW = tileWidth / 2;
        const hH = tileHeight / 2;
        const gx = (u, v) => sp.x + u * hW - v * hW;
        const gy = (u, v) => sp.y + u * hH + v * hH;

        // Path width in UV space (matches sq values of 0.13)
        const pathW = 0.13;

        // FIXED Z-SORTING: Draw Top and Left paths (based on neighbors)
        // These are drawn on the CURRENT tile, which renders ON TOP of the Previous tiles (Top/Left neighbors).

        // LEFT PATH (Connects to Left Neighbor's Right Path)
        // Checks if Left Neighbor (x-1) has a Right Path.
        // Strip spans u=[0-pathW, 0+pathW] -> actually centered on u=0.
        // Wait, u=0 is Left Edge?
        // drawIsoTileG: gx = sx + u*hW + v*(-hW).
        // if u=0, gx = sx - v*hW. This is the Left-Down edge (if v goes 0->1).
        // Let's verify Top Edge (v=0). gx = sx + u*hW. This is Right-Down.
        // Actually:
        // Top Corner: u=0, v=0
        // Right Corner: u=1, v=0
        // Bottom Corner: u=1, v=1
        // Left Corner: u=0, v=1

        // Edge u=0 (v 0->1): Connects Top (0,0) to Left (0,1). This is the LEFT-UP edge visually? 
        // No, isometric:
        // 0,0 is Top Center.
        // 1,0 is Right Center.
        // 0,1 is Left Center.
        // 1,1 is Bottom Center.

        // So:
        // u varies 0->1, v=0: Top -> Right (Upper Right Edge) -> "Right-Up"? No, standard iso is Top->Right.
        // This is the edge shared with Y-1? No, Y is vertical.
        // Let's look at grid layout:
        // Grid y increases down-left? Or down-right?
        // isoToScreen(x, y): y = (x+y). Y screen increases with both.
        // x screen = (x-y). 
        // x+1 -> Screen X moves Right (+), Screen Y moves Down (+). ("Bottom-Right" direction)
        // y+1 -> Screen X moves Left (-), Screen Y moves Down (+). ("Bottom-Left" direction)

        // So:
        // X+1 Neighbor is to the Bottom-Right.
        // Y+1 Neighbor is to the Bottom-Left.
        // X-1 Neighbor is to the Top-Left.
        // Y-1 Neighbor is to the Top-Right.

        // Current Tile covers X-1 and Y-1 (Painter's algo: Y loop then X loop).
        // Wait: for (y=0..N) for (x=0..N).
        // (0,0) drawn first. (0,1) drawn next. (0,1) is Bottom-Left neighbor of (0,0).
        // So (0,1) covers (0,0).
        // (1,0) drawn next? No, x loop inside.
        // (0,0), (1,0), (2,0)...
        // (1,0) is Bottom-Right neighbor of (0,0).
        // So (1,0) covers (0,0).

        // So a tile covers its Top-Left (X-1) and Top-Right (Y-1) neighbors.
        // Therefore, we must draw the paths shared with X-1 and Y-1 ON THE CURRENT TILE.

        // Edge shared with X-1 (Top-Left neighbor):
        // This is the "Left" edge of Current Tile (or Right edge of X-1).
        // In UV: Connects (0,0) to (0,1). i.e. u=0 line.
        // So we draw a strip around u=0.

        if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) {
            const u0 = -pathW, u1 = pathW; // Centered on u=0
            pg.drawPolygon([
                gx(u0, 0), gy(u0, 0),
                gx(u1, 0), gy(u1, 0),
                gx(u1, 1), gy(u1, 1), // u=0, v=1 is Left Corner
                gx(u0, 1), gy(u0, 1)
            ]);
        }

        // Edge shared with Y-1 (Top-Right neighbor):
        // This is the "Top" edge of Current Tile (or Bottom edge of Y-1).
        // In UV: Connects (0,0) to (1,0). i.e. v=0 line.
        // So we draw a strip around v=0.

        if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) {
            const v0 = -pathW, v1 = pathW; // Centered on v=0
            pg.drawPolygon([
                gx(0, v0), gy(0, v0),
                gx(1, v0), gy(1, v0), // u=1, v=0 is Right Corner
                gx(1, v1), gy(1, v1),
                gx(0, v1), gy(0, v1)
            ]);
        }

        // INTERNAL PATHS (Cross, etc)? 
        // If plot has its OWN paths that are internal?
        // The data model assumes paths are on edges (right/bottom).
        // We are just rendering the OTHER half of the edge (the one belonging to the neighbor) here.
        // BUT wait, we must ALSO render the half belonging to US if it's not internal?
        // No, the path is a shared edge. It's drawn once.
        // If we currently draw Right/Bottom:
        // Right is shared with X+1. X+1 covers us. So X+1 must draw it (as its Left).
        // Bottom is shared with Y+1. Y+1 covers us. So Y+1 must draw it (as its Top).
        // So indeed, we ONLY draw Left (neighbor's Right) and Top (neighbor's Bottom).
        // And we STOP drawing our own Right/Bottom.
        // EXCEPT: What about the map edges (Isoscapes)?
        // If x=Max, no X+1 exists to draw our Right path.
        // If y=Max, no Y+1 exists to draw our Bottom path.
        // So for boundary tiles, we must still draw Right/Bottom?
        // User map seems to be within bounds.
        // Let's stick to the overlap logic. It's cleaner.
        // If boundary paths are missing, it's a minor edge case compared to Z-fighting.


        pg.endFill();
        tile.addChild(pg);
    }

    // ---- Vegetation Helper (Replaces Legacy Loop) ----
    function addVegetation(tile, x, y, plot, zone, rCtx) {
        // 1. Determine Variant
        let variant = 0; // Park
        // If Logic for variant
        const checkNeighbor = (dx, dy, type) => {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                return (zoneGrid[ny][nx].name === type); // Simple check
            }
            return false;
        };
        // Garden (1) if surrounded by housing? Legacy logic was intricate.
        // Simplified: GREEN = Park (0), Garden (1), or Wilderness (2).
        // Let's us deterministic seed.
        const seed = (x * 13 + y * 7) % 100;
        if (plot.name === 'GREEN') {
            if (seed < 33) variant = 2; // Wilderness
            else if (seed < 66) variant = 1; // Garden
            else variant = 0; // Park
        }
        // FIX: Removed EXISTING check here so they don't get treated as Gardens. 
        // Existing buildings will be drawn in addTileObjects.

        // 2. Iterate Grid (3x3)
        // Indices 0..8
        // 0 1 2
        // 3 4 5
        // 6 7 8
        // Deterministic Shuffle
        let shuffleSeed = x * 71523 + y * 92719;
        const seededRandom = () => {
            const r = Math.sin(shuffleSeed++) * 10000;
            return r - Math.floor(r);
        };
        const shuffledIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        for (let i = shuffledIndices.length - 1; i > 0; i--) {
            const j = Math.floor(seededRandom() * (i + 1));
            [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]];
        }

        // Density Control
        // Density Control
        let itemsToDraw = (plot.treeCount !== undefined) ? plot.treeCount : 3;

        // TERRACE LOGIC FOR GARDEN (Variant 1)
        // Must be done BEFORE vegetation loop to exclude spots.
        let terraceIndices = [];
        if (plot.name === 'GREEN' && variant === 1) {
            // Valid 1x2 Pairs
            const validPairs = [
                // Horizontal
                [0, 1], [1, 2], [3, 4], [4, 5], [6, 7], [7, 8],
                // Vertical
                [0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8]
            ];
            // Pick Random Pair
            const pairVal = Math.floor(seededRandom() * validPairs.length);
            terraceIndices = validPairs[pairVal];

            // NOTE: We don't filter shuffledIndices because it's const.
            // We'll check terraceIndices in the loop.

            // Draw Terrace NOW (Background layer)
            const gT = _acquireGraphics();
            gT.beginFill(0xEEDCBA); // Lighter Brown / Beige (was 0xD2B48C)

            // Calculate Union Polygon for the 2 cells
            const cell = 1 / 3;
            // Get min/max col/row
            let minC = 3, maxC = -1, minR = 3, maxR = -1;
            terraceIndices.forEach(idx => {
                const c = idx % 3;
                const r = Math.floor(idx / 3);
                if (c < minC) minC = c;
                if (c > maxC) maxC = c;
                if (r < minR) minR = r;
                if (r > maxR) maxR = r;
            });

            // Bounds in UV (relative to center)
            const inset = 0.05;
            const u0 = (minC - 1) * cell - cell / 2 + inset;
            const u1 = (maxC - 1) * cell + cell / 2 - inset;
            const v0 = (minR - 1) * cell - cell / 2 + inset;
            const v1 = (maxR - 1) * cell + cell / 2 - inset;

            // Project 4 Corners
            const corners = [
                { u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }
            ];

            const pts = corners.map(p => {
                const ox = (p.u - p.v) * (tileWidth / 2);
                const oy = (p.u + p.v) * (tileHeight / 2);
                // Base pos is tile center
                return new PIXI.Point(
                    isoToScreen(x, y).x + ox,
                    isoToScreen(x, y).y + tileHeight * 0.5 + oy
                );
            });

            gT.drawPolygon(pts);
            gT.endFill();
            // Fix: Add at index 1 (above ground, below path/objects)
            // If only ground exists (length 1), index 1 is valid (append).
            // If path exists (length 2), index 1 inserts between ground and path.
            if (tile.children.length > 0) {
                tile.addChildAt(gT, 1);
            } else {
                tile.addChild(gT);
            }
        }

        if (plot.name === 'GREEN') {
            // Base items per variant
            let baseItems = 1;
            if (variant === 0) { // Park: Just grass with a tree
                baseItems = 1;
                // Random placement (no forced center)
            } else if (variant === 1) { // Garden: Path, 1 tree, 2-3 bushes
                baseItems = 4; // Leaves 5 empty spots for "paths"
            } else if (variant === 2) { // Wilderness: A few trees and bushes
                baseItems = 6; // Dense but not full (was 9)
            }
            // Add donated trees on top of the base count (treeCount includes own + donations)
            // treeCount = 1 (own) + N (donated). Extra donated = treeCount - 1.
            const donatedExtra = Math.max(0, (plot.treeCount || 0) - 1);
            itemsToDraw = Math.min(9, baseItems + donatedExtra); // Cap at 9 (3x3 grid)
        }

        // Remove the old "fill all" logic
        // if (variant === 1 || variant === 2) itemsToDraw = 9; 

        let drawnCount = 0;

        for (let i = 0; i < 9; i++) {
            if (drawnCount >= itemsToDraw) break;
            const posIndex = shuffledIndices[i];

            // EXCLUSION: Terrace
            if (terraceIndices.includes(posIndex)) continue;

            const col = posIndex % 3;
            const row = Math.floor(posIndex / 3);

            // 3. Exclusions
            // Paths
            if (plot.paths) {
                // Legacy: 
                // Right Edge (X+1) -> Mask Col 2
                if (plot.paths.right && col === 2) continue;
                // Bottom Edge (Y+1) -> Mask Row 2
                if (plot.paths.bottom && row === 2) continue;
            }
            // Neighbor Paths (simplified)
            if (y > 0 && dataGrid[y - 1][x].paths?.bottom && row === 0) continue;
            if (x > 0 && dataGrid[y][x - 1].paths?.right && col === 0) continue;

            // Workshop Footprint
            if (plot.name === 'WORKSHOP') {
                const lay = workshopLayouts.get(`${x},${y}`);
                if (lay) {
                    const wVar = lay.variant, wRot = lay.rotation;
                    let excluded = [];
                    // Base Masks (0=Up/Top-Right in Iso?) No, rotation logic is tricky.
                    // Legacy: 0=Garage(1,4,7), 1=Social(0,1,3,4), 2=Actual(1,3,4,5,7)
                    if (wVar === 0) excluded = [1, 4, 7];
                    else if (wVar === 1) excluded = [0, 1, 3, 4];
                    else if (wVar === 2) excluded = [1, 3, 4, 5, 7];

                    // Rotate Mask
                    // Use helper or just hardcode for now. 
                    // Let's assume standard rotation logic from legacy:
                    const rotateIdx = (idx, times) => {
                        for (let t = 0; t < times; t++) {
                            const r = Math.floor(idx / 3), c = idx % 3;
                            idx = c * 3 + (2 - r);
                        }
                        return idx;
                    };
                    const finalSuspended = excluded.map(idx => rotateIdx(idx, wRot));
                    if (finalSuspended.includes(posIndex)) continue;
                }
            }
            // Farming Handling (Crops?)
            if (plot.name === 'FARMING' && !plot.mergedWith) {
                // Legacy farming split check
                const fLay = (typeof getFarmingLayout !== 'undefined') ? getFarmingLayout(x, y) : { split: 'X', brownFirst: true };
                // Logic: Skip Brown Halves
                if (fLay.split === 'X') {
                    // Col 0,1 vs 1,2?
                    // Legacy: if brownFirst && col <= 1 continue
                    // Actually, let's just allow vegetation on Green half only?
                    // Or simple random scatter.
                    // For safety, let's skip farming vegetation for now to see ground.
                    // Or just allow it.
                    // Legacy Code:
                    // if (layout.split === 'X') { if (layout.brownFirst && col <= 1) continue; ... }
                    if (fLay.split === 'X') {
                        if (fLay.brownFirst && col <= 1) continue;
                        if (!fLay.brownFirst && col >= 1) continue;
                    } else {
                        if (fLay.brownFirst && row <= 1) continue;
                        if (!fLay.brownFirst && row >= 1) continue;
                    }
                }
            }

            // 4. Calculate Position
            const sp = isoToScreen(x, y); // Top Vertex (Top-Center)
            // Grid Alignment (3x3) - Isometric Projection
            // Center of cell (0,0) is tile center.
            // u, v are local grid coordinates (-1 to +1 range for full tile width)
            // But here we want -1/3, 0, +1/3 offsets relative to center.

            const cell = 1 / 3;
            // col, row are 0, 1, 2.
            // u, v offsets from center: -1, 0, 1 * cell
            const u = (col - 1) * cell;
            const v = (row - 1) * cell;

            // ISOMETRIC PROJECTION
            // x_screen = (u - v) * (tileWidth / 2)
            // y_screen = (u + v) * (tileHeight / 2)
            const ox = (u - v) * (tileWidth / 2);
            const oy = (u + v) * (tileHeight / 2);

            const tx = sp.x + ox;
            const ty = sp.y + tileHeight * 0.5 + oy;

            // 5. Draw
            const g = _acquireGraphics();
            const inShadow = false; // TODO: Implement shadow lookup?
            const isDying = (plot.decayStage || 0) > 0;
            const hSeed = (x * 37 + y * 13 + posIndex * 7) % 3;
            let hScale = (hSeed === 0) ? 0.8 : (hSeed === 1 ? 1.0 : 1.2);

            if (rCtx.lod >= 1) {
                // LOD 1: simple colored circle per vegetation item
                let color, radius;
                if (variant === 1 && i > 0) { color = 0x66BB6A; radius = 4 * 0.9 * (tileHeight / 30); } // bush
                else if (variant === 2 && i >= 3) { color = 0x43A047; radius = 2.5 * (tileHeight / 30); } // scrub
                else { color = 0x7FCD91; radius = 6 * hScale * (tileHeight / 30); } // tree
                g.beginFill(color);
                g.drawCircle(tx, ty - radius, radius);
                g.endFill();
            } else if (variant === 1) { // Garden
                if (i === 0) drawPixiTree(g, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', 0.9 * (tileHeight / 30), inShadow, isDying, rCtx.showOutlines);
                else drawPixiBush(g, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', 0.9 * (tileHeight / 30), inShadow, isDying, rCtx.showOutlines);
            } else if (variant === 2) { // Wilderness
                if (i < 3) drawPixiTree(g, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', hScale * 0.9 * (tileHeight / 30), inShadow, isDying, rCtx.showOutlines);
                else {
                    const sSize = (hSeed === 0) ? 1.4 : 1.0;
                    drawPixiScrub(g, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', sSize * (tileHeight / 30), inShadow, isDying, rCtx.showOutlines);
                }
            } else { // Park
                drawPixiTree(g, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', hScale * (tileHeight / 30), inShadow, isDying, rCtx.showOutlines);
            }
            tile.addChild(g);
            drawnCount++;
        }
    }

    // ---- 3D objects: buildings, sport items, trees ----
    function addTileObjects(tile, x, y, sp, plot, zone, sq, rCtx) {
        if (plot && plot.name === 'REMOVED') return;
        // LOD 2: skip all 3D objects (flat map view)
        if (rCtx.lod >= 2) return;
        // Hide all buildings/objects when showObjects is toggled off
        if (!showObjects) return;

        // In edit mode, only render EXISTING buildings (so they appear when painted)
        if (rCtx.isEditMode) {
            if (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY' && plot.name !== 'GREEN')) {
                // Fall through to render EXISTING buildings below
            } else {
                return;
            }
        }

        // Rule highlighting: suppress 3D objects for non-highlighted tiles
        if (rCtx.effectiveRule && !plot._cachedHighlight) {
            return; // Don't draw buildings/trees on dimmed tiles
        }

        // SPECIAL VISUAL REQUEST: Hide objects (trees/bushes/etc) in Industrial Buffer
        // When showing the buffer zone, we want a clean highlight without clutter.
        if (rCtx.effectiveRule === 'workshopDistance') {
            const isExisting = (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY'));
            const isWorkshop = (plot.name === 'WORKSHOP');
            if (!isExisting && !isWorkshop) {
                return; // Suppress rendering of trees/sports/farms in this view
            }
        }

        // SPECIAL VISUAL REQUEST: Hide objects in Recreational Buffer
        // Hide trees, roof gardens, farming plots within the buffer zone.
        if (rCtx.effectiveRule === 'sportDistance') {
            const isExisting = (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY'));
            const isSport = (plot.name === 'SPORT');
            if (!isExisting && !isSport) {
                return; // Suppress rendering of trees/farms/workshops in this view
            }
        }

        // ====== MERGED GREEN (PARK) ======
        if (plot.name === 'GREEN' && plot.mergedWith && plot.isMergeMaster && rCtx.effectiveRule !== 'greenZoneCompliance') {
            const px = plot.mergedWith.x, py = plot.mergedWith.y;
            if (rCtx.renderShadows) {
                try {
                    const s = createMergedPark(x, y, px, py, true, 'SHADOW', 'ALL', tileWidth, tileHeight, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, lightenColor, darkenColor, rCtx.showOutlines);
                    if (s) tile.addChild(s);
                } catch (e) { console.warn('MergedPark shadow error:', e); }
            }
            try {
                const b = createMergedPark(x, y, px, py, rCtx.renderShadows, 'BUILDING', 'ALL', tileWidth, tileHeight, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, lightenColor, darkenColor, rCtx.showOutlines);
                if (b) tile.addChild(b);
            } catch (e) { console.warn('MergedPark build error:', e); }
        }

        // ====== MERGED FARMING (GREENHOUSE) ======
        // Suppress greenhouse during greenZoneCompliance highlight
        else if (plot.name === 'FARMING' && plot.mergedWith && plot.isMergeMaster && rCtx.effectiveRule !== 'greenZoneCompliance') {
            const ghColor = plot.scoreColor || '#52B788';
            const px = plot.mergedWith.x, py = plot.mergedWith.y;

            // FIX: Render ENTIRE merged building on the "Back" tile to avoid seams.
            // We use the tile with the lower Y-order (or left-most) as the anchor.
            // Since we are iterating Y then X, and isMergeMaster is usually determined by iteration order (or merge logic),
            // we will just render onto the CURRENT tile (Master).
            // Note: If Master is essentially the "Back" (top/left) tile, this works perfectly for Painter's Algo.
            // If Master is "Front", the building is drawn later, covering "Back" sprites. This is also fine.
            // The Key is: ONE PASS with 'ALL'.

            if (rCtx.renderShadows) {
                try {
                    const s = createGreenhouse(x, y, px, py, true, 'SHADOW', 'ALL', tileWidth, tileHeight, null, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, hexToRgba, ghColor, rCtx.showOutlines);
                    if (s) tile.addChild(s);
                } catch (e) { console.warn('Greenhouse shadow error:', e); }
            }
            try {
                const b = createGreenhouse(x, y, px, py, rCtx.renderShadows, 'BUILDING', 'ALL', tileWidth, tileHeight, null, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, hexToRgba, ghColor, rCtx.showOutlines);
                if (b) tile.addChild(b);
            } catch (e) { console.warn('Greenhouse build error:', e); }
        }

        // ====== MERGED WORKSHOP ======
        else if (plot.name === 'WORKSHOP' && plot.mergedWith && plot.isMergeMaster) {
            let drawColor = plot.color || '#FFE0B2'; // Updated default pastel
            if ((plot.decayStage || 0) > 0) drawColor = darkenColor(drawColor, 35);
            const isGZC = simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN';
            const px = plot.mergedWith.x, py = plot.mergedWith.y;

            // FIX: Render ENTIRE merged building on Master tile (Single Pass)
            const treeCallback = (g, tx, ty, s, gs, sc, sns, hs) => {
                drawPixiTree(g, tx, ty, s, gs, sc, sns, hs, false, false, rCtx.showOutlines);
            };

            if (rCtx.renderShadows) {
                try {
                    const s = createWorkshop(x, y, px, py, true, 'SHADOW', 'ALL', tileWidth, tileHeight, null, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, lightenColor, darkenColor, drawColor, dataGrid, numCols, numRows, rCtx.showOutlines, isGZC, 'MERGED', 0, treeCallback);
                    if (s) tile.addChild(s);
                } catch (e) { console.warn('Workshop shadow error:', e); }
            }
            try {
                const b = createWorkshop(x, y, px, py, rCtx.renderShadows, 'BUILDING', 'ALL', tileWidth, tileHeight, null, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, lightenColor, darkenColor, drawColor, dataGrid, numCols, numRows, rCtx.showOutlines, isGZC, 'MERGED', 0, treeCallback);
                if (b) tile.addChild(b);
            } catch (e) { console.warn('Workshop build error:', e); }
        }

        // ====== SINGLE WORKSHOP ======
        else if (plot.name === 'WORKSHOP' && !plot.mergedWith) {
            let drawColor = plot.color || '#FFE0B2';
            if ((plot.decayStage || 0) > 0) drawColor = darkenColor(drawColor, 35);
            const lay = workshopLayouts.get(`${x},${y}`);
            const wV = lay ? lay.variant : 0, wR = lay ? lay.rotation : 0;
            const isGZC = simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN';

            const treeCallback = (g, tx, ty, s, gs, sc, sns, hs) => {
                drawPixiTree(g, tx, ty, s, gs, sc, sns, hs, false, false, rCtx.showOutlines);
            };

            try {
                const ws = createWorkshop(x, y, x, y, rCtx.renderShadows, 'BUILDING', 'ALL', tileWidth, tileHeight, null, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', isoToScreen, lightenColor, darkenColor, drawColor, dataGrid, numCols, numRows, rCtx.showOutlines, isGZC, wV, wR, treeCallback);
                if (ws) tile.addChild(ws);
            } catch (e) { console.warn('Single workshop error:', e); }
        }

        // ====== EXISTING BUILDINGS ======
        else if (plot.name === 'EXISTING' || (zone.name === 'EXISTING_HOUSING' && plot.name !== 'EMPTY' && plot.name !== 'GREEN')) {
            const drawColor = '#FFFFFF'; // White (String for darkenColor safety)
            const hScale = 1.2; // 12m approx

            // Neighbor Check for Merging
            const checkEx = (nx, ny) => {
                if (nx < 0 || nx >= numCols || ny < 0 || ny >= numRows) return false;
                const p = dataGrid[ny][nx];
                const z = zoneGrid[ny][nx];
                return (p.name === 'EXISTING' || (z.name === 'EXISTING_HOUSING' && p.name !== 'EMPTY' && p.name !== 'GREEN'));
            };

            const nTop = checkEx(x, y - 1);
            const nRight = checkEx(x + 1, y);
            const nBottom = checkEx(x, y + 1);
            const nLeft = checkEx(x - 1, y);
            const nTopLeft = checkEx(x - 1, y - 1);
            const nTopRight = checkEx(x + 1, y - 1);
            const nBottomRight = checkEx(x + 1, y + 1);
            const nBottomLeft = checkEx(x - 1, y + 1);

            // Door Logic & Colors (skip at LOD 1+)
            const doorData = {};
            if (rCtx.lod === 0 && simulationRules.doorCreation && (!rCtx.effectiveRule || rCtx.effectiveRule === 'doorCreation')) {
                const checkDoor = (dx, dy, face) => {
                    if (hasDoor(dataGrid, x, y, face)) {
                        const nx = x + dx, ny = y + dy;
                        let col = '#CCCCCC'; // default
                        if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                            const nPlot = dataGrid[ny][nx];
                            // Use plot color if available, or fallback to type default
                            // Note: plotTypes definition might be needed if plot.color is undefined
                            col = nPlot.color || (plotTypes[nPlot.name] ? plotTypes[nPlot.name].color : '#CCCCCC');

                            // Special case: Green Type might need specific hex
                            if (nPlot.name === 'GREEN') col = '#A5D6A7'; // Example Green
                            if (nPlot.name === 'FARMING') col = '#D69E2E';
                            if (nPlot.name === 'WORKSHOP') col = '#8B6914'; // Dark Gold
                            if (nPlot.name === 'SPORT') col = '#2F80ED'; // Blue
                        }
                        return { exists: true, color: col };
                    }
                    return null;
                };

                doorData.top = checkDoor(0, -1, 'top');
                doorData.right = checkDoor(1, 0, 'right');
                doorData.bottom = checkDoor(0, 1, 'bottom');
                doorData.left = checkDoor(-1, 0, 'left');
            }

            const g = _acquireGraphics();
            drawSimpleBuilding(
                g, x, y, tileWidth, tileHeight, hScale, drawColor,
                rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)',
                isoToScreen, lightenColor, darkenColor,
                { top: nTop, right: nRight, bottom: nBottom, left: nLeft, topLeft: nTopLeft, topRight: nTopRight, bottomRight: nBottomRight, bottomLeft: nBottomLeft },
                (rCtx.showOutlines) ? 1 : 0, // Outline VISIBLE only if user explicitly disabled Shadows
                doorData // Pass Door Data
            );
            tile.addChild(g);

            // ---- ROOF GARDEN on EXISTING buildings ---- (skip at LOD 1+)
            // Suppress roof gardens for certain rule highlights
            const suppressRoofGardenRules = ['sportDistance', 'farmingNeighbor', 'doorCreation', 'aqueductGreenOnly', 'treeDonation', 'workshopDistance'];
            if (rCtx.lod === 0 && plot.hasRoofGarden && simulationRules.toppingRule && (!rCtx.effectiveRule || !suppressRoofGardenRules.includes(rCtx.effectiveRule))) {
                const blockZ = tileHeight * hScale;
                const hW = tileWidth / 2, hH = tileHeight / 2;
                const cx = sp.x, cy = sp.y + hH;
                // Inset the garden slightly (15% margin)
                const inset = 0.85;
                const rg = _acquireGraphics();
                const gardenColor = 0x95D5B2; // Green
                rg.beginFill(gardenColor, 0.8);
                rg.drawPolygon([
                    cx, cy - hH * inset - blockZ,                    // top
                    cx + hW * inset, cy - blockZ,                    // right
                    cx, cy + hH * inset - blockZ,                    // bottom
                    cx - hW * inset, cy - blockZ                     // left
                ]);
                rg.endFill();
                // Add a small tree on the roof garden
                try {
                    const treeG = _acquireGraphics();
                    const tx = cx, ty = cy - blockZ - tileHeight * 0.05;
                    drawPixiTree(treeG, tx, ty, false, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', 0.6 * (tileHeight / 30), false, false, rCtx.showOutlines);
                    tile.addChild(rg);
                    tile.addChild(treeG);
                } catch (e) { tile.addChild(rg); }
            }

            // ---- DOORS on EXISTING buildings ---- (skip at LOD 1+)
            if (rCtx.lod === 0 && simulationRules.doorCreation && (!rCtx.effectiveRule || rCtx.effectiveRule === 'doorCreation')) {
                const blockZ = tileHeight * hScale;
                const hW = tileWidth / 2, hH = tileHeight / 2;
                const cx = sp.x, cy = sp.y + hH;
                const doorColor = 0xA1887F; // Pastel brown
                const doorH = blockZ * 0.22;
                const doorW = 0.11;

                // Wall Inset Logic (must match drawSimpleBuilding)
                const inset = 0.1;

                // Right face door (Facing "South-East" / Bottom-Right on screen)
                // Wall goes from Right-Tip to Bottom-Tip.
                // Normal "Right Tip" is (cx + hW, cy).
                // Normal "Bottom Tip" is (cx, cy + hH).
                // If !nRight (merged neighbor), wall is recessed.
                // Inset logic: uMax = 0.5 - (nRight ? 0 : inset).
                // Midpoint of wall: u = 0.5 - inset_factor. v = varies.
                // Wall is defined by u = Constant?
                // Visual Right Face is u = uMax line? 
                // Let's check drawSimpleBuilding: "2. Right Face ... bBottom, bRight ...".
                // bRight = (uMax, vMin). bBottom = (uMax, vMax).
                // So Right Face = line from vMin to vMax at u = uMax.

                // Door should be centered on this wall?
                // Midpoint: u = uMax, v = (vMin + vMax)/2.
                // vMin = -0.5 + (nTop?0:inset).
                // vMax = 0.5 - (nBottom?0:inset).
                // midV = (vMin + vMax) / 2.

                // Position (x,y)
                // Position (x,y)
                const getIso = (u, v) => ({
                    x: cx + (u - v) * hW,
                    y: cy + (u + v) * hH
                });

                if (hasDoor(dataGrid, x, y, 'right')) {
                    const uMax = 0.5 - (nRight ? 0 : inset);
                    const vMin = -0.5 + (nTop ? 0 : inset);
                    const vMax = 0.5 - (nBottom ? 0 : inset);
                    const midV = (vMin + vMax) / 2; // Center of the wall length

                    const pos = getIso(uMax, midV);
                    // This is the BASE of the door on the wall.

                    const dg = _acquireGraphics();

                    const nx = x + 1, ny = y;
                    const nPlot = (nx < numCols) ? dataGrid[ny][nx] : null;
                    const nColorStr = (nPlot && nPlot.name !== 'EMPTY') ? (nPlot.color || plotTypes[nPlot.name].color) : '#A1887F';
                    const doorColor = parseInt(nColorStr.replace('#', '0x')) || 0xA1887F;

                    // Door slope (along the wall vector V)
                    // Wall vector is V-axis: (-hW * 2, hH * 2) per unit V?
                    // isoToPoint(u, v+1) - isoToPoint(u, v) = (-2hW, 2hH).
                    // Correct: Down-Left.

                    // We want door width around pos.
                    // dV for door width?
                    // doorW is fraction of tile?
                    // Let's use simplified slope from original code but applied to pos.
                    const dx = hW * doorW * 0.7;
                    const dy = hH * doorW * 0.7;

                    dg.beginFill(doorColor, 1);
                    dg.drawPolygon([
                        pos.x + dx, pos.y - dy - doorH,
                        pos.x - dx, pos.y + dy - doorH,
                        pos.x - dx, pos.y + dy,
                        pos.x + dx, pos.y - dy
                    ]);
                    dg.endFill();
                    tile.addChild(dg);
                }

                // Bottom face door (Facing "South-West" / Bottom-Left on screen)
                // Wall goes from Bottom-Tip to Left-Tip.
                // Left Face? No, script says 'bottom'.
                // Grid 'bottom' (y+1) -> Visual Bottom-Left Edge (bBottom to bLeft).
                // This is defined by v = vMax line?
                // drawSimpleBuilding: Left Face: bLeft, bBottom.
                // bLeft = (uMin, vMax). bBottom = (uMax, vMax).
                // So "Left Face" (Visual) corresponds to v = vMax.
                // Which neighbor?
                // bLeft to bBottom is boundary with y+1 (Bottom Neighbor).

                if (hasDoor(dataGrid, x, y, 'bottom')) { // y+1
                    // Visual Left Face (v=vMax).
                    const vMax = 0.5 - (nBottom ? 0 : inset);
                    const uMin = -0.5 + (nLeft ? 0 : inset);
                    const uMax = 0.5 - (nRight ? 0 : inset);
                    const midU = (uMin + uMax) / 2;

                    const pos = getIso(midU, vMax);

                    // Wall vector is U-axis: (+2hW, +2hH) per unit U.
                    // Down-Right.

                    const dx = hW * doorW * 0.7;
                    const dy = hH * doorW * 0.7;

                    // Slope for Bottom-Left face (Down-Right visual)
                    // Top-Right to Bottom-Left?
                    // door slope should match wall slope (U axis).
                    // U axis goes (x+, y+).

                    const ddx = hW * doorW * 0.7; // U-axis projection?
                    const ddy = -hH * doorW * 0.7; // Wait.

                    // Visual Right Face (right door) was Down-Left slope.
                    // Visual Left Face (bottom door) is Down-Right slope.
                    // Original code: midX + dx...
                    // Let's stick to simple offset logic:
                    // dx is width in x, dy is width in y (slope).
                    // For Left Face (Bottom Neighbor), wall slopes Down-Right.
                    // (x increases, y increases).

                    const dg = _acquireGraphics();
                    dg.beginFill(doorColor, 1);
                    const dg2 = _acquireGraphics();
                    dg2.beginFill(doorColor, 1);
                    dg2.drawPolygon([
                        pos.x - dx, pos.y - dy - doorH, // Top-Left (Up-Slope?)
                        pos.x + dx, pos.y + dy - doorH, // Top-Right (Down-Slope)
                        pos.x + dx, pos.y + dy,
                        pos.x - dx, pos.y - dy
                    ]);
                    dg2.endFill();
                    tile.addChild(dg2);
                }

                // Add Top and Left doors?
                // Usually not visible from this angle, but good for completeness?
                // The original code only had Right and Bottom.
            }
        }

        // ====== SINGLE FARMING (Sheds/Stacks) ======
        else if (plot.name === 'FARMING' && !plot.mergedWith) {
            // Only suppress during greenZoneCompliance HIGHLIGHT (not during normal rendering)
            if (rCtx.effectiveRule === 'greenZoneCompliance' && zoneGrid[y][x].name === 'GREEN') { /* skip during highlight */ }
            else {
                try {
                    const hSeed = (x * 492 + y * 821);
                    const rawQuad = (plot.occupiedQuad !== undefined) ? plot.occupiedQuad : ((x + y * 2) % 4);
                    // Skip rendering if no valid quadrant (all blocked by roads/paths)
                    if (rawQuad === -1) throw 'no valid quadrant';
                    const quadrant = rawQuad;

                    const fb = createFarmingBuilding(
                        x, y, rCtx.renderShadows, 'ALL',
                        tileWidth, tileHeight, pixiGetShadowShift,
                        'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)',
                        isoToScreen, lightenColor, darkenColor,
                        plot.color || '#D4A373', quadrant, hSeed,
                        dataGrid, numCols, numRows, rCtx.showOutlines
                    );
                    if (fb) tile.addChild(fb);
                } catch (e) { console.warn('Farming building error:', e); }
            }
        }

        // ====== SPORT ITEMS (3D objects) ======
        else if (plot.name === 'SPORT') {
            // Suppress sport objects during greenZoneCompliance highlight
            if (rCtx.effectiveRule !== 'greenZoneCompliance') {
                const lay = sportLayouts.get(`${x},${y}`);
                const sV = lay ? lay.variant : 0, sR = lay ? lay.rotation : 0;
                try {
                    const sg = _acquireGraphics();
                    addSportObject(sg, sp.x, sp.y, tileWidth, tileHeight, sV, sR, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', null, plot.isMergeMaster || false, sq);
                    tile.addChild(sg);
                } catch (e) { console.warn('Sport object error:', e); }

                // ADD TREE RENDER FOR SPORT PLOTS (If trees exist, e.g. when rule is OFF)
                // Exclude Variant 3 (Tennis) just in case logic allowed it (User Request)
                if (plot.treeCount > 0 && sV !== 3) {
                    try {
                        const tg = _acquireGraphics();
                        // Random offset but clear of center (where sport items usually represent)
                        // Simple 4-corner jitter or side placement
                        const hSeed = (x * 67 + y * 71) % 4;
                        let tx = sp.x, ty = sp.y + tileHeight * 0.5; // Center
                        const offset = tileWidth * 0.25;

                        // Corners: 0=Top, 1=Right, 2=Bot, 3=Left
                        if (hSeed === 0) { ty -= tileHeight * 0.25; }
                        else if (hSeed === 1) { tx += offset; }
                        else if (hSeed === 2) { ty += tileHeight * 0.25; }
                        else { tx -= offset; }

                        // Draw 1 tree (or more if treeCount > 1, but let's stick to 1 representative for now)
                        drawPixiTree(tg, tx, ty, rCtx.renderShadows, pixiGetShadowShift, 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0)', 0.8 * (tileHeight / 30), false, false, rCtx.showOutlines);
                        tile.addChild(tg);
                    } catch (e) { }
                }
            }
        }



        // ====== VEGETATION (Trees/Bushes) ======
        // Suppress vegetation during greenZoneCompliance highlight
        if (((plot.name === 'GREEN' && !plot.mergedWith) || plot.name === 'WORKSHOP' || (plot.name === 'FARMING' && !plot.mergedWith) || (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING')) && rCtx.effectiveRule !== 'greenZoneCompliance') {
            try { addVegetation(tile, x, y, plot, zone, rCtx); } catch (e) { }
        }

        // ====== FENCES & HEDGES (Boundaries) ======
        // Draw between this tile and neighbors (Right and Bottom only to avoid dupes)
        // Logic:
        // Green-Green -> Low Hedge
        // Workshop-Workshop -> Low Fence
        // Different Types -> High Hedge
        // Suppress hedges during greenZoneCompliance highlight
        // LOD 1+: skip hedges/fences entirely
        if (!rCtx.isEditMode && rCtx.effectiveRule !== 'greenZoneCompliance' && rCtx.lod === 0) {
            const drawBoundary = (neighbor, side) => {
                if (!neighbor || neighbor.name === 'EMPTY' || plot.name === 'EMPTY') return;
                if (plot.name === 'EXISTING' || neighbor.name === 'EXISTING') return; // Existing handled by walls
                if (plot.name === 'FARMING' && plot.mergedWith && plot.mergedWith === neighbor.mergedWith) return; // Merged internal
                if (plot.name === 'WORKSHOP' && plot.mergedWith && plot.mergedWith === neighbor.mergedWith) return; // Merged internal
                // No hedge if neighbor is part of the SAME merged building
                // No hedge if neighbor is part of the SAME merged building
                const startNx = (side === 'right') ? x + 1 : x;
                const startNy = (side === 'bottom') ? y + 1 : y;
                if (plot.mergedWith && plot.mergedWith.x === startNx && plot.mergedWith.y === startNy) return;

                if (plot.name === 'SPORT' && neighbor.name === 'SPORT') return; // No hedge between sports

                let type = 'HIGH_HEDGE';
                if (plot.name === 'GREEN' && neighbor.name === 'GREEN') type = 'LOW_HEDGE';
                else if (plot.name === 'FARMING' && neighbor.name === 'FARMING') type = 'LOW_HEDGE'; // Low hedge for Farm-Farm
                else if (plot.name === 'WORKSHOP' && neighbor.name === 'WORKSHOP') type = 'LOW_FENCE';

                // PATH CHECK (Strict): Don't draw hedge if there is a path ON THIS EDGE
                // Right Edge: corresponding to plot.paths.right
                // Bottom Edge: corresponding to plot.paths.bottom
                if (side === 'right' && plot.paths && plot.paths.right) return;
                if (side === 'bottom' && plot.paths && plot.paths.bottom) return;

                // CROP SIDES (Shorten Start/End if perpendicular paths exist)
                // Right Edge:
                // - Start: Top-Right corner. Perpendicular path is Top Edge (plot.paths.top? No, neighbor y-1 bottom, or logic).
                //   Actually, we need to check if there is a path running along the Top edge of this tile (v=0).
                // - End: Bottom-Right corner. Perpendicular path is Bottom Edge (plot.paths.bottom).

                // Helper to safely get path
                const hasPath = (tx, ty, dir) => {
                    if (tx < 0 || ty < 0 || tx >= numCols || ty >= numRows) return false;
                    const p = dataGrid[ty][tx];
                    return p.paths && p.paths[dir];
                };

                let cropStart = false;
                let cropEnd = false;

                if (side === 'right') {
                    // Hedge runs along Right edge (Vertical)
                    // Start Point (Top-Right): Check Top Path (y-1 'bottom')
                    if (hasPath(x, y - 1, 'bottom')) cropStart = true;
                    // End Point (Bottom-Right): Check Bottom Path (this 'bottom')
                    if (hasPath(x, y, 'bottom')) cropEnd = true;
                } else { // bottom
                    // Hedge runs along Bottom edge (Horizontal)
                    // Start Point (Bottom-Left): Check Left Path (x-1 'right')
                    if (hasPath(x - 1, y, 'right')) cropStart = true;
                    // End Point (Bottom-Right): Check Right Path (this 'right')
                    if (hasPath(x, y, 'right')) cropEnd = true;
                }

                // Draw
                const g = _acquireGraphics();
                const hW = tileWidth / 2, hH = tileHeight / 2;
                const zBase = 0;
                const zHeight = (type === 'HIGH_HEDGE') ? tileHeight * 0.18 : tileHeight * 0.08;
                const color = (type === 'LOW_FENCE') ? 0x8D6E63 : 0x5D7D68; // Desaturated Sage Green (Opaque)

                // Coordinates
                let p1, p2;
                if (side === 'right') {
                    p1 = { x: sp.x + hW, y: sp.y + hH };
                    p2 = { x: sp.x, y: sp.y + 2 * hH };
                } else { // bottom
                    p1 = { x: sp.x - hW, y: sp.y + hH };
                    p2 = { x: sp.x, y: sp.y + 2 * hH };
                }

                // Apply Cropping
                const cropLen = tileWidth * 0.15; // Crop amount
                if (cropStart) {
                    const dx = p2.x - p1.x, dy = p2.y - p1.y;
                    const len = Math.hypot(dx, dy);
                    const u = cropLen / len;
                    p1.x += dx * u; p1.y += dy * u;
                }
                if (cropEnd) {
                    const dx = p2.x - p1.x, dy = p2.y - p1.y;
                    const len = Math.hypot(dx, dy);
                    const u = cropLen / len;
                    p2.x -= dx * u; p2.y -= dy * u;
                }

                // Offset for thickness
                // Just draw a thick line or a vertical quad
                if (type === 'LOW_FENCE') g.beginFill(color, 1);
                else g.beginFill(color, 1.0); // Fully Opaque

                g.drawPolygon([
                    p1.x, p1.y,
                    p2.x, p2.y,
                    p2.x, p2.y - zHeight,
                    p1.x, p1.y - zHeight
                ]);
                g.endFill();
                tile.addChild(g);
            };

            if (x < numCols - 1) drawBoundary(dataGrid[y][x + 1], 'right');
            if (y < numRows - 1) drawBoundary(dataGrid[y + 1][x], 'bottom');
        }
    }

    // ---- Update a single tile (for incremental updates after ticks) ----
    function updateTile(x, y) {
        if (!gridGraphicRefs[y] || !gridGraphicRefs[y][x]) {
            // Visible, non-REMOVED tile without a container (skipped in buildWorld): fall back to a full rebuild
            if (x >= 0 && x < numCols && y >= 0 && y < numRows && dataGrid[y] && dataGrid[y][x] && dataGrid[y][x].name !== 'REMOVED' &&
                lastVisibleRange && x >= lastVisibleRange.startX && x <= lastVisibleRange.endX && y >= lastVisibleRange.startY && y <= lastVisibleRange.endY) {
                worldDirty = true;
                fullRebuildNeeded = true;
            }
            return;
        }
        const container = gridGraphicRefs[y][x];
        // Release Graphics children back to pool before clearing
        for (let i = 0; i < container.children.length; i++) {
            const ch = container.children[i];
            if (ch instanceof PIXI.Graphics) {
                ch.clear();
                _graphicsPool.push(ch);
            }
        }
        container.removeChildren();

        const isDark = document.body.classList.contains('dark-mode');
        const gridAlpha = isDark ? 0.12 : (showShadows ? 0.12 : 0.4);
        const rCtx = {
            isDark,
            gridAlpha,
            gridStrokeHex: isDark ? 0xFFFFFF : 0x000000,
            emptyHex: isDark ? 0x374151 : 0xFFFFFF,
            renderShadows: showShadows && !isInteracting,
            showOutlines: !showShadows,
            isEditMode: currentMode === 'draw'
        };
        populateTile(container, x, y, rCtx);
    }

    function drawStaticToCache(targetCtx, width, height, options = {}) {



        // PERFORMANCE: Dynamic Quality
        const renderShadows = showShadows; // Export always renders full shadows

        // SAFETY CHECK: Ensure Grid Exists
        if (!dataGrid || !dataGrid.length) return;

        // LOCAL RENDER LIST (Fixes Export Glitch)
        // Ensure we always start with a clean list for THIS render pass
        const renderList = [];

        // Options
        const { transparentBackground = false } = options;

        // Initial Clear & State Reset (Fix for "Windows XP" duplication glitch)
        if (!transparentBackground) {
            // "Nuclear Option" REPLACED with efficient Clear
            // Use clearRect + resetTransform to ensure full clear without allocation churn
            targetCtx.setTransform(1, 0, 0, 1, 0, 0);
            targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);

            // Draw Background to match CSS container
            // Use save/restore + resetTransform to ensure we fill the PHYSICAL canvas,
            // regardless of any scale transforms active (like in Pixel Mode)
            targetCtx.save();
            targetCtx.setTransform(1, 0, 0, 1, 0, 0); // Identity transform
            const isDark = document.body.classList.contains('dark-mode');
            // FIX: Match CSS variables exactly!
            // Light: var(--canvas-bg) = #E2E8F0
            // Dark: var(--canvas-bg-dark) = #171923
            targetCtx.fillStyle = isDark ? '#171923' : '#E2E8F0';
            targetCtx.fillRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
            targetCtx.restore();
        } else {
            // Ensure transparent clean
            // Note: clears rect in transformed space if transformed. This is usually desired for transparent backgrounds.
            targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
        }
        // Note: targetCtx.canvas reference works for both OnScreen and OffScreen canvas

        // Calculate LOGICAL Width/Height for Culling
        // If we are in an internal pixel pass, the physical canvas is tiny (e.g. 1/8th).
        // But our coordinates are still in "Screen Space" (e.g. 1920px wide).
        // So we must upscale the canvas dimensions to match the coordinate space for valid culling.
        let logicalWidth = targetCtx.canvas.width;
        let logicalHeight = targetCtx.canvas.height;



        const isEditMode = currentMode === 'draw';

        // --- DRAW GRID SLAB (BASE) ---
        // ... rest of drawScene relies on isoToScreen which now handles Pan/Zoom
        // ... and uses tileWidth/tileHeight which are now scaled.
        // CHECK: slabThickness should probably scale too?
        // It uses "tileHeight * 0.75". Since tileHeight is scaled, slabThickness scales automatically!

        if (showSlab) { // Visible in ALL modes
            const topCorner = isoToScreen(0, 0);
            const rightCorner = isoToScreen(numCols, 0);
            const bottomCorner = isoToScreen(numCols, numRows);
            const leftCorner = isoToScreen(0, numRows);

            const slabThickness = tileHeight * 0.75; // Auto-scaled
            // const slabColorLeft = '#D3D3D3'; // Light Grey (Lit side) - Lighter for pastel look
            const slabColorRight = '#A9A9A9'; // Dark Grey (Shadow side) - Reverted to distinct darker grey

            // Draw Left Face (From Left to Bottom)
            targetCtx.fillStyle = '#D3D3D3'; // Light Grey (Lit side) - Lighter for pastel look
            targetCtx.beginPath();
            targetCtx.moveTo(leftCorner.x, leftCorner.y);
            targetCtx.lineTo(bottomCorner.x, bottomCorner.y);
            targetCtx.lineTo(bottomCorner.x, bottomCorner.y + slabThickness);
            targetCtx.lineTo(leftCorner.x, leftCorner.y + slabThickness);
            targetCtx.closePath();
            targetCtx.fill();

            // Draw Right Face (From Bottom to Right)
            targetCtx.fillStyle = slabColorRight;
            targetCtx.beginPath();
            targetCtx.moveTo(bottomCorner.x, bottomCorner.y);
            targetCtx.lineTo(rightCorner.x, rightCorner.y);
            targetCtx.lineTo(rightCorner.x, rightCorner.y + slabThickness);
            targetCtx.lineTo(bottomCorner.x, bottomCorner.y + slabThickness);
            targetCtx.closePath();
            targetCtx.fill();
        }

        // Define Grid Path for Shadow Clipping
        const gridPath = new Path2D();
        const shadowColor = 'rgba(0, 0, 0, 0.2)';
        const shadowNoStroke = 'rgba(0, 0, 0, 0)';
        const topC = isoToScreen(0, 0); // Recalculate or reuse if scope allows. 
        // Note: isoToScreen arguments are (gridX, gridY).
        // 0,0 is Top. numCols,0 is Right. numCols,numRows is Bottom. 0,numRows is Left.
        // We can reuse the vars if they are in scope.
        // topCorner, rightCorner etc are inside the "if (!isEditMode...)" block above (lines 844-847).
        // We probably want gridPath generally available or calculated here.
        // Moving definitions up is harder with replace_file_content.
        // Let's just calc them here.
        gridPath.moveTo(isoToScreen(0, 0).x, isoToScreen(0, 0).y);
        gridPath.lineTo(isoToScreen(numCols, 0).x, isoToScreen(numCols, 0).y);
        gridPath.lineTo(isoToScreen(numCols, numRows).x, isoToScreen(numCols, numRows).y);
        gridPath.lineTo(isoToScreen(0, numRows).x, isoToScreen(0, numRows).y);
        gridPath.closePath();

        // OUTLINE MODE: Draw thick border around grid+slab (behind plots for cleaner look)
        if (!showShadows) {
            const scaleFactor = tileHeight / 30;
            const slabThickness = tileHeight * 0.75; // Match slab thickness

            // Define corners
            const topC = isoToScreen(0, 0);
            const rightC = isoToScreen(numCols, 0);
            const bottomC = isoToScreen(numCols, numRows);
            const leftC = isoToScreen(0, numRows);

            // Create path that goes around grid top and slab sides
            const borderPath = new Path2D();
            borderPath.moveTo(topC.x, topC.y);
            borderPath.lineTo(rightC.x, rightC.y);
            borderPath.lineTo(rightC.x, rightC.y + slabThickness);
            borderPath.lineTo(bottomC.x, bottomC.y + slabThickness);
            borderPath.lineTo(leftC.x, leftC.y + slabThickness);
            borderPath.lineTo(leftC.x, leftC.y);
            borderPath.closePath();

            targetCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            targetCtx.lineWidth = 3.0 * scaleFactor;
            targetCtx.lineCap = 'round';
            targetCtx.lineJoin = 'round';
            targetCtx.stroke(borderPath);
        }

        // Dark Mode Check
        // Dark Mode Check
        const isModeDark = document.body.classList.contains('dark-mode');
        const emptyTileColor = isModeDark ? '#374151' : '#FFFFFF'; // Cool Gray 700 - Visibly lighter than background

        let gridAlpha;
        if (isModeDark) {
            // Dark Mode: Keep grid subtle and CONSTANT regardless of shadows/rules
            gridAlpha = 0.12;
        } else {
            // Light Mode: Adapt to shadows
            if (showShadows) {
                gridAlpha = 0.12;
            } else {
                gridAlpha = 0.4; // High contrast
            }
        }

        // PIXEL MODE OVERRIDES for crisp look
        if (options.isInternalPixelPass) {
            gridAlpha = 1.0; // Force solid lines for crisp pixel art look
            // Scale Line Width to match Factor so it draws as 1 physical pixel
            if (options.pixelFactor) {
                targetCtx.lineWidth = options.pixelFactor;
            }
        }

        const gridStrokeColor = isModeDark
            ? `rgba(255,255,255,${gridAlpha})`
            : `rgba(0, 0, 0, ${gridAlpha})`;





        // Draw background image first (if loaded)
        if (backgroundImage) {
            targetCtx.save();
            targetCtx.globalAlpha = imageSettings.opacity;
            const scaledWidth = backgroundImage.width * imageSettings.scaleX;
            const scaledHeight = backgroundImage.height * imageSettings.scaleY;
            targetCtx.drawImage(
                backgroundImage,
                imageSettings.offsetX,
                imageSettings.offsetY,
                scaledWidth,
                scaledHeight
            );
            targetCtx.restore();
        }




        // 2a. Pre-calculate Sport Layouts (Adjacency Merging)
        sportLayouts = new Map(); // Reset global map
        const visitedSport = new Set();

        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                if (!plot || plot.name !== 'SPORT') continue;
                if (visitedSport.has(`${x},${y}`)) continue;

                // Priority Check: Persistent Merge (Tennis Court - Variant 3)
                if (plot.mergedWith && plot.isMergeMaster) {
                    // It's a Tennis Court Master
                    // Determine rotation based on merge direction
                    // Horizontal: Master is Left? Or checks dx/dy
                    let rotation = 0;
                    if (plot.mergedWith.x > x) rotation = 0; // Horizontal (Master Left)
                    else if (plot.mergedWith.y > y) rotation = 1; // Vertical (Master Top)

                    // Register BOTH parts
                    sportLayouts.set(`${x},${y}`, { variant: 3, rotation: rotation });
                    sportLayouts.set(`${plot.mergedWith.x},${plot.mergedWith.y}`, { variant: 3, rotation: rotation + 2 }); // Flip for partner? Or handle in draw?
                    // Actually, let's keep it simple: Variant 3 implies Tennis.
                    // We need to know if it's horizontal or vertical merge.
                    // Let's use Rotation 0 for Horiz, 1 for Vert.

                    visitedSport.add(`${x},${y}`);
                    visitedSport.add(`${plot.mergedWith.x},${plot.mergedWith.y}`);
                    continue;
                } else if (plot.mergedWith) {
                    // It's a Tennis Court Slave (skip, already handled)
                    visitedSport.add(`${x},${y}`);
                    continue;
                }

                // Determine Variant from Seed (Default)
                const seed = (x * 492 + y * 821);
                let rawVariant = Math.floor(Math.abs(Math.sin(seed) * 1000)) % 3; // 0, 1, 2

                // Only merge if neighbors allow.
                // If merged -> Force Variant 3 (Tennis).
                // If not merged -> Keep rawVariant (0, 1, 2).

                let merged = false;

                // Check Horizontal (Right) - visual pairing only, keeps original variant
                if (rawVariant !== 2) {
                    const rightPlot = (x + 1 < numCols) ? dataGrid[y][x + 1] : null;
                    if (rightPlot && rightPlot.name === 'SPORT' && !rightPlot.mergedWith && !visitedSport.has(`${x + 1},${y}`)) {
                        sportLayouts.set(`${x},${y}`, { variant: rawVariant, rotation: 0 });
                        sportLayouts.set(`${x + 1},${y}`, { variant: rawVariant, rotation: 2 });
                        visitedSport.add(`${x},${y}`);
                        visitedSport.add(`${x + 1},${y}`);
                        merged = true;
                    }

                    // Check Vertical (Down) - Only if not merged horizontally
                    if (!merged) {
                        const downPlot = (y + 1 < numRows) ? dataGrid[y + 1][x] : null;
                        if (downPlot && downPlot.name === 'SPORT' && !downPlot.mergedWith && !visitedSport.has(`${x},${y + 1}`)) {
                            sportLayouts.set(`${x},${y}`, { variant: rawVariant, rotation: 1 });
                            sportLayouts.set(`${x},${y + 1}`, { variant: rawVariant, rotation: 3 });
                            visitedSport.add(`${x},${y}`);
                            visitedSport.add(`${x},${y + 1}`);
                            merged = true;
                        }
                    }
                }

                if (!merged) {
                    // Single Plot: Soccer (0), Basketball (1), Workout (2)
                    const rot = Math.floor(Math.abs(Math.cos(seed) * 1000)) % 4;
                    sportLayouts.set(`${x},${y}`, { variant: rawVariant, rotation: rot });
                    visitedSport.add(`${x},${y}`);
                }
            }
        }


        // 2b. Pre-calculate Workshop Layouts
        workshopLayouts = new Map(); // Reset global map
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                if (!plot || plot.name !== 'WORKSHOP') continue;

                // Generate persistent random variant (0-2) and rotation (0-3)
                const seed = (x * 563 + y * 331);
                // Variant 0: Garage, 1: Social, 2: Actual
                let variant = Math.floor(Math.abs(Math.sin(seed) * 1000)) % 3;
                let rotation = Math.floor(Math.abs(Math.cos(seed) * 1000)) % 4;

                // GARAGE ROAD ORIENTATION: If this is a garage, rotate to face the road or path
                // REFINEMENT: Only apply this rotation if 'Right of Way' Rule (buildingRoadConstraint) is ACTIVE.
                // Otherwise, show random rotation to visualise the "before" state.
                // ROAD ORIENTATION LOGIC
                // If 'Right of Way' Rule is ACTIVE, rotate buildings to face roads/paths/open space.
                if (simulationRules.buildingRoadConstraint) {

                    // Check neighbors
                    const roadRight = checkIsRoad(x + 1, y);
                    const pathRight = plot.paths && plot.paths.right;
                    const validRight = roadRight || pathRight;

                    const roadBottom = checkIsRoad(x, y + 1);
                    const pathBottom = plot.paths && plot.paths.bottom;
                    const validBottom = roadBottom || pathBottom;

                    const roadLeft = checkIsRoad(x - 1, y);
                    const pathLeft = (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right);
                    const validLeft = roadLeft || pathLeft;

                    const roadTop = checkIsRoad(x, y - 1);
                    const pathTop = (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom);
                    const validTop = roadTop || pathTop;

                    if (variant === 0 || variant === 2) {
                        // VARIANT 0 (Garage) & VARIANT 2 (Actual/Shed)
                        // Both have a "Front" (Y+) that should face the road.
                        // Shed has lumber/open space at Front. Garage has Car at Front.

                        // Prioritize orientation (Right -> Bottom -> Left -> Top)
                        if (validRight) {
                            rotation = 3; // Faces X+ (Right)
                        } else if (validBottom) {
                            rotation = 0; // Faces Y+ (Bottom) - Default
                        } else if (validLeft) {
                            rotation = 1; // Faces X- (Left)
                        } else if (validTop) {
                            rotation = 2; // Faces Y- (Top)
                        }
                    } else if (variant === 1) {
                        // VARIANT 1 (Social)
                        // Square building at Top-Left. Open Space at Bottom-Right.
                        // We want Open Space to face the road.
                        // Rot 0: Open Bottom-Right (Good for Right, Bottom)
                        // Rot 1: Open Bottom-Left (Good for Left, Bottom)
                        // Rot 2: Open Top-Left (Good for Left, Top)
                        // Rot 3: Open Top-Right (Good for Right, Top)

                        let bestRot = rotation; // Keep random if no roads
                        let maxScore = -1;

                        const checkScore = (rot, s) => {
                            if (s > maxScore) { maxScore = s; bestRot = rot; }
                        };

                        // Score 0: R + B
                        checkScore(0, (validRight ? 1 : 0) + (validBottom ? 1 : 0));
                        // Score 1: L + B
                        checkScore(1, (validLeft ? 1 : 0) + (validBottom ? 1 : 0));
                        // Score 2: L + T
                        checkScore(2, (validLeft ? 1 : 0) + (validTop ? 1 : 0));
                        // Score 3: R + T
                        checkScore(3, (validRight ? 1 : 0) + (validTop ? 1 : 0));

                        // Use best if we found any connection
                        if (maxScore > 0) {
                            rotation = bestRot;
                        }
                    }
                }

                workshopLayouts.set(`${x},${y}`, { variant, rotation });
            }
        }

        // (Pass 0.5 removed - logic integrated into Pass 1)


        // PASS 1: DRAW GROUND TILES
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                const zone = zoneGrid[y][x];
                const screenPos = isoToScreen(x, y);

                // PERFORMANCE: View Culling (Strict for Objects)
                // Fix: Use LOGICAL dimensions
                const margin = tileWidth * 6; // Generous margin for tall buildings
                if (screenPos.x < -margin || screenPos.x > logicalWidth + margin ||
                    screenPos.y < -margin || screenPos.y > logicalHeight + margin) {
                    continue;
                }

                // Refactored drawTile with Scale Support and SQUISH LOGIC
                // --- HIGHLIGHT LOGIC MOVED UP ---
                let isHigh = isHighlighted(x, y, plot, zone);

                // GREEN ZONE COMPLIANCE RULE: Highlight Green Zones and Workshops within them
                if (getEffectiveHighlightRule() === 'greenZoneCompliance') {
                    // Highlight the ENTIRE Zone (All plots within Green Zone)
                    if (zone.name === 'GREEN') {
                        isHigh = true;
                    }
                }

                plot._cachedHighlight = isHigh;

                // Buffer Rule Suppression Helper
                // If we are in a buffer rule (Workshop/Sport), and this plot is highlighted (meaning it's in the buffer)
                // AND it's not the actual Building/Sport plot itself... then suppress details.
                const isBufferSuppressed = () => {
                    if ((getEffectiveHighlightRule() === 'workshopDistance' || getEffectiveHighlightRule() === 'sportDistance') && isHigh) {
                        if (getEffectiveHighlightRule() === 'workshopDistance' && plot.name === 'WORKSHOP') return false;
                        if (getEffectiveHighlightRule() === 'sportDistance' && plot.name === 'SPORT') return false;
                        return true;
                    }
                    return false;
                };

                // SQUISH CALCULATION (Pass 1)
                let squish = { l: 0, r: 0, t: 0, b: 0 };
                // Suppress squish (path gaps) when any rule highlight is active except rightOfWay
                const suppressSquishCanvas = getEffectiveHighlightRule() && getEffectiveHighlightRule() !== 'buildingRoadConstraint';
                if (!suppressSquishCanvas) {
                    if (plot.paths) {
                        if (plot.paths.right) squish.r = 0.13;
                        if (plot.paths.bottom) squish.b = 0.13;
                    }
                    if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) squish.l = 0.13;
                    if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) squish.t = 0.13;
                }



                // CALC HOVER STATE
                // CALC HOVER STATE (Disabled for Static Cache)
                const isHovered = false; // Hover effects rendered in dynamic layer
                const tileLineWidth = 0.5;
                const tileStrokeColor = gridStrokeColor;

                const drawTile = (color, height = 0, stroke = gridStrokeColor, scale = 1.0, squish = { l: 0, r: 0, t: 0, b: 0 }, lineWidth = 0.5) => {
                    let drawC = color;
                    // Squish Factors ... (omitted for brevity, assume passed correctly)

                    // ... (Squish & Geometry Logic remains same) ...

                    // Correct.
                    const vU = { x: tileWidth / 2, y: tileHeight / 2 }; // Vector for U=1
                    const vV = { x: -tileWidth / 2, y: tileHeight / 2 }; // Vector for V=1
                    const origin = { x: screenPos.x, y: screenPos.y }; // Top Tip (u=0, v=0)

                    // Helper
                    const getS = (u, v) => ({
                        x: origin.x + u * vU.x + v * vV.x,
                        y: origin.y + u * vU.y + v * vV.y
                    });

                    // Scale Logic: Center crop
                    const outputU0 = (1 - scale) / 2;
                    const outputU1 = 1 - outputU0;
                    const outputV0 = (1 - scale) / 2;
                    const outputV1 = 1 - outputV0;

                    // Combine Squish (Gap) and Scale (Edit Mode)
                    const u0 = Math.max(squish.l, outputU0);
                    const u1 = Math.min(1 - squish.r, outputU1);
                    const v0 = Math.max(squish.t, outputV0);
                    const v1 = Math.min(1 - squish.b, outputV1);

                    // New Corners
                    const c1 = getS(u0, v0); // Top-ish
                    const c2 = getS(u1, v0); // Right-ish
                    const c3 = getS(u1, v1); // Bottom-ish
                    const c4 = getS(u0, v1); // Left-ish

                    // Draw
                    targetCtx.fillStyle = drawC;
                    targetCtx.beginPath();
                    targetCtx.moveTo(c1.x, c1.y);
                    targetCtx.lineTo(c2.x, c2.y);
                    targetCtx.lineTo(c3.x, c3.y);
                    targetCtx.lineTo(c4.x, c4.y);
                    targetCtx.closePath();

                    // Scoring Logic Reuse
                    if (visualizeScores && plot.name !== 'EMPTY' && plot.name !== 'FARMING') {
                        let baseVal = 0;
                        if (plot.name === 'GREEN') baseVal = simulationParameters.baseScoreGreen;
                        else if (plot.name === 'SPORT') baseVal = simulationParameters.baseScoreSport;
                        else if (plot.name === 'WORKSHOP') baseVal = simulationParameters.baseScoreWorkshop;
                        else baseVal = plotTypes[plot.name]?.value || 0;

                        const delta = Math.max(0, plot.value - baseVal);
                        const intensity = Math.min(0.7, delta * 0.25);

                        if (intensity > 0) {
                            let targetColor = '#2F4F4F';
                            if (plot.name === 'WORKSHOP') targetColor = '#8B4513';
                            else if (plot.name === 'GREEN') targetColor = '#1B4332';
                            else if (plot.name === 'SPORT') targetColor = '#154360';

                            const interp = (c1, c2, f) => {
                                let r1 = parseInt(c1.substring(1, 3), 16), g1 = parseInt(c1.substring(3, 5), 16), b1 = parseInt(c1.substring(5, 7), 16);
                                let r2 = parseInt(c2.substring(1, 3), 16), g2 = parseInt(c2.substring(3, 5), 16), b2 = parseInt(c2.substring(5, 7), 16);
                                let r = Math.round(r1 + (r2 - r1) * f), g = Math.round(g1 + (g2 - g1) * f), b = Math.round(b1 + (b2 - b1) * f);
                                return `#${(r < 16 ? '0' : '') + r.toString(16)}${(g < 16 ? '0' : '') + g.toString(16)}${(b < 16 ? '0' : '') + b.toString(16)}`;
                            };

                            drawC = interp(drawC, targetColor, intensity);
                            targetCtx.fillStyle = drawC;
                        }
                    }
                    targetCtx.fill();

                    if (stroke !== 'rgba(0,0,0,0)' && scale === 1.0) {
                        targetCtx.strokeStyle = stroke;
                        // Use thicker lines in Pixel Mode to ensure visibility at low res
                        const pFactor = (options && options.isInternalPixelPass) ? (options.pixelFactor || pixelFactor) : 1;
                        targetCtx.lineWidth = lineWidth * pFactor;
                        targetCtx.stroke();
                    }
                };

                // MERGED FARMING GROUND
                // STRICT WHITELIST: Only render if NO rule is active OR rule is 'farmingNeighbor'
                if (plot.name === 'FARMING' && !isEditMode && plot.mergedWith && (!getEffectiveHighlightRule() || getEffectiveHighlightRule() === 'farmingNeighbor')) {
                    // Buffer Suppression: Force Amber and Skip
                    if (isBufferSuppressed()) {
                        drawTile('#FFAB00', 0, gridStrokeColor, 1.0, { l: 0, r: 0, t: 0, b: 0 });
                        continue;
                    }

                    // HIGHLIGHT CHECK: Skip if rule active and not highlighted
                    // (isHigh is already calculated)
                    // HIGHLIGHT CHECK REMOVED - Fall through to main loop
                    // if (getEffectiveHighlightRule() && !isHigh) { ... }

                    let mergedColor = '#52B788'; // Unified green color (Same as standard Farming green)

                    if (visualizeScores) {
                        // Calculate Score Color
                        const baseVal = simulationParameters.baseScoreFarming;
                        const delta = Math.max(0, (plot.value || 0) - baseVal);
                        const intensity = Math.min(0.7, delta * 0.25);

                        // Interpolate towards Deep Hunter Green (#1B4332) - same as standard Green
                        // Or maybe a richer farming green? Let's use #1B4332 for consistency with Green zones.
                        const interp = (c1, c2, f) => {
                            let r1 = parseInt(c1.substring(1, 3), 16), g1 = parseInt(c1.substring(3, 5), 16), b1 = parseInt(c1.substring(5, 7), 16);
                            let r2 = parseInt(c2.substring(1, 3), 16), g2 = parseInt(c2.substring(3, 5), 16), b2 = parseInt(c2.substring(5, 7), 16);
                            let r = Math.round(r1 + (r2 - r1) * f), g = Math.round(g1 + (g2 - g1) * f), b = Math.round(b1 + (b2 - b1) * f);
                            return `#${(r < 16 ? '0' : '') + r.toString(16)}${(g < 16 ? '0' : '') + g.toString(16)}${(b < 16 ? '0' : '') + b.toString(16)}`;
                        };
                        mergedColor = interp(mergedColor, '#1B4332', intensity);
                        plot.scoreColor = mergedColor; // Save for 3D Pass
                    } else {
                        plot.scoreColor = null;
                    }

                    // Brighten if highlighted
                    if (getEffectiveHighlightRule() && isHigh) {
                        // Logic: Don't brighten "Door Source" plots
                        const isDoorSource = getEffectiveHighlightRule() === 'doorCreation' &&
                            (plot.name !== 'EXISTING' && zone.name !== 'EXISTING_HOUSING');

                        // Buffer Color Override (Unified Amber)
                        let isBuffer = false;
                        if ((getEffectiveHighlightRule() === 'workshopDistance' && hasExistingNeighbor(x, y, 2)) ||
                            (getEffectiveHighlightRule() === 'sportDistance' && hasExistingNeighbor(x, y, 1))) {
                            mergedColor = '#FFAB00'; // Amber (Unified Warning Color)
                            isBuffer = true;
                        }

                        if (!isDoorSource && !isBuffer) {
                            mergedColor = lightenColor(mergedColor, 30);
                        } else if (isBuffer) {
                            // Keep pure Amber
                        }
                    }

                    const strokeColor = gridStrokeColor;
                    drawTile(mergedColor, 0, strokeColor, 1.0, squish);
                    continue; // Skip standard tile rendering
                }
                // MERGED WORKSHOP GROUND
                // STRICT WHITELIST: Only render if NO rule is active OR rule is 'workshopRoadBonus'/'workshopDistance'
                else if (plot.name === 'WORKSHOP' && !isEditMode && plot.mergedWith && (!getEffectiveHighlightRule() || getEffectiveHighlightRule() === 'workshopRoadBonus' || getEffectiveHighlightRule() === 'workshopDistance')) {
                    // Buffer Suppression: Force Amber and Skip
                    if (isBufferSuppressed()) {
                        // Exception: If this is a WORKSHOP plot and rule is WORKSHOP, we want to show it?
                        // isBufferSuppressed() already handles exceptions for Rule Targets!
                        // If isBufferSuppressed() is true, it means it's NOT the target.
                        drawTile('#FFAB00', 0, gridStrokeColor, 1.0, { l: 0, r: 0, t: 0, b: 0 });
                        continue;
                    }

                    // HIGHLIGHT CHECK: Skip if rule active and not highlighted
                    // HIGHLIGHT CHECK REMOVED - Fall through to main loop
                    // if (getEffectiveHighlightRule() && !isHigh) { ... }

                    let mergedColor = '#FFCB77'; // Unified pastel orange

                    if (visualizeScores) {
                        const baseVal = simulationParameters.baseScoreWorkshop;
                        const delta = Math.max(0, (plot.value || 0) - baseVal);
                        const intensity = Math.min(0.7, delta * 0.25);
                        // Interpolate towards SaddleBrown
                        const interp = (c1, c2, f) => {
                            let r1 = parseInt(c1.substring(1, 3), 16), g1 = parseInt(c1.substring(3, 5), 16), b1 = parseInt(c1.substring(5, 7), 16);
                            let r2 = parseInt(c2.substring(1, 3), 16), g2 = parseInt(c2.substring(3, 5), 16), b2 = parseInt(c2.substring(5, 7), 16);
                            let r = Math.round(r1 + (r2 - r1) * f), g = Math.round(g1 + (g2 - g1) * f), b = Math.round(b1 + (b2 - b1) * f);
                            return `#${(r < 16 ? '0' : '') + r.toString(16)}${(g < 16 ? '0' : '') + g.toString(16)}${(b < 16 ? '0' : '') + b.toString(16)}`;
                        };
                        mergedColor = interp(mergedColor, '#8B4513', intensity);
                    }

                    // Brighten if highlighted
                    if (getEffectiveHighlightRule() && isHigh) {
                        // Logic: Don't brighten "Door Source" plots
                        const isDoorSource = getEffectiveHighlightRule() === 'doorCreation' &&
                            (plot.name !== 'EXISTING' && zone.name !== 'EXISTING_HOUSING');

                        if (!isDoorSource) {
                            mergedColor = lightenColor(mergedColor, 30);
                        }
                    }

                    const strokeColor = gridStrokeColor;
                    drawTile(mergedColor, 0, strokeColor, 1.0, squish);
                    continue; // Skip standard tile rendering
                }
                // Special rendering for FARMING
                // STRICT WHITELIST: Only render if NO rule is active OR rule is 'farmingNeighbor'
                // REFINEMENT: Suppress in Green Zone Compliance (Show only Zone)
                else if (plot.name === 'FARMING' && !isEditMode && (isHigh || !getEffectiveHighlightRule()) && getEffectiveHighlightRule() !== 'greenZoneCompliance') {
                    // Buffer Suppression: Force Amber and Skip
                    // Buffer Suppression: Force Amber and Skip
                    if (isBufferSuppressed()) {
                        drawTile('#FFAB00', 0, gridStrokeColor, 1.0, { l: 0, r: 0, t: 0, b: 0 });
                        continue;
                    }

                    // HIGHLIGHT CHECK: Skip if rule active and not highlighted
                    // HIGHLIGHT CHECK REMOVED - Fall through to main loop
                    // if (getEffectiveHighlightRule() && !isHigh) { ... }

                    // Removed clip() to avoid state issues. Using direct geometry.

                    // Default fallback layout if function missing
                    let layout = { split: 'X', brownFirst: true };
                    if (typeof getFarmingLayout === 'function') {
                        layout = getFarmingLayout(x, y);
                    }

                    // Hardcoded classic colors to ensure visibility
                    let brownColor = '#A18D70'; // Earth Bricks
                    let greenColor = '#52B788'; // Farming Green

                    // Simple Score Visualization (Darkening only)
                    if (visualizeScores) {
                        const baseVal = simulationParameters.baseScoreFarming || 0;
                        const pVal = plot.value || 0;
                        const delta = Math.max(0, pVal - baseVal);
                        const percent = Math.min(40, delta * 30);
                        if (!isNaN(percent) && percent > 0) {
                            brownColor = darkenColor(brownColor, percent);
                            greenColor = darkenColor(greenColor, percent);
                        }
                    }

                    targetCtx.globalAlpha = 1.0;

                    if ((plot.decayStage || 0) > 0) {
                        // targetCtx.globalAlpha = 0.2; // REMOVED Transparency
                        // Darken logic moved to color definition (lines below)
                        brownColor = darkenColor(brownColor, 35);
                        greenColor = darkenColor(greenColor, 35);
                    }

                    if (layout.split === 'X') {
                        // Split X
                        targetCtx.fillStyle = layout.brownFirst ? brownColor : greenColor;
                        targetCtx.beginPath();
                        targetCtx.moveTo(screenPos.x, screenPos.y);
                        targetCtx.lineTo(screenPos.x + tileWidth / 4, screenPos.y + tileHeight / 4);
                        targetCtx.lineTo(screenPos.x - tileWidth / 4, screenPos.y + 3 * tileHeight / 4);
                        targetCtx.lineTo(screenPos.x - tileWidth / 2, screenPos.y + tileHeight / 2);
                        targetCtx.closePath();
                        targetCtx.fill();

                        targetCtx.fillStyle = layout.brownFirst ? greenColor : brownColor;
                        targetCtx.beginPath();
                        targetCtx.moveTo(screenPos.x + tileWidth / 4, screenPos.y + tileHeight / 4);
                        targetCtx.lineTo(screenPos.x + tileWidth / 2, screenPos.y + tileHeight / 2);
                        targetCtx.lineTo(screenPos.x, screenPos.y + tileHeight);
                        targetCtx.lineTo(screenPos.x - tileWidth / 4, screenPos.y + 3 * tileHeight / 4);
                        targetCtx.closePath();
                        targetCtx.fill();
                    } else {
                        // Split Y
                        targetCtx.fillStyle = layout.brownFirst ? brownColor : greenColor;
                        targetCtx.beginPath();
                        targetCtx.moveTo(screenPos.x, screenPos.y);
                        targetCtx.lineTo(screenPos.x + tileWidth / 2, screenPos.y + tileHeight / 2);
                        targetCtx.lineTo(screenPos.x + tileWidth / 4, screenPos.y + 3 * tileHeight / 4);
                        targetCtx.lineTo(screenPos.x - tileWidth / 4, screenPos.y + tileHeight / 4);
                        targetCtx.closePath();
                        targetCtx.fill();

                        targetCtx.fillStyle = layout.brownFirst ? greenColor : brownColor;
                        targetCtx.beginPath();
                        targetCtx.moveTo(screenPos.x - tileWidth / 4, screenPos.y + tileHeight / 4);
                        targetCtx.lineTo(screenPos.x + tileWidth / 4, screenPos.y + 3 * tileHeight / 4);
                        targetCtx.lineTo(screenPos.x, screenPos.y + tileHeight);
                        targetCtx.lineTo(screenPos.x - tileWidth / 2, screenPos.y + tileHeight / 2);
                        targetCtx.closePath();
                        targetCtx.fill();
                    }

                    // Redefine Path for Stroke
                    targetCtx.beginPath();
                    targetCtx.moveTo(screenPos.x, screenPos.y);
                    targetCtx.lineTo(screenPos.x + tileWidth / 2, screenPos.y + tileHeight / 2);
                    targetCtx.lineTo(screenPos.x, screenPos.y + tileHeight);
                    targetCtx.lineTo(screenPos.x - tileWidth / 2, screenPos.y + tileHeight / 2);
                    targetCtx.closePath();

                    targetCtx.strokeStyle = tileStrokeColor;
                    targetCtx.lineWidth = tileLineWidth;
                    targetCtx.stroke();
                    targetCtx.globalAlpha = 1.0; // Reset
                    continue; // Skip standard tile rendering
                }

                // --- HIGHLIGHT LOGIC ---
                // const isHigh = isHighlighted(x, y, plot, zone); // MOVED UP
                // plot._cachedHighlight = isHigh; // MOVED UP

                // Skip rendering if rule is active and this element is NOT highlighted
                // (Handled by fallthrough + guard clause below)
                // if (getEffectiveHighlightRule() && !isHigh) { ... } REMOVED

                // DRAW BASE FILL LAYER FIRST (so Grid Lines are visible on top)
                // Skip if background image is loaded (so we can see it through empty tiles)
                if (!backgroundImage) {
                    drawTile(emptyTileColor, 0, 'rgba(0,0,0,0)');
                }

                // DRAW GRID STROKE ON TOP
                targetCtx.strokeStyle = gridStrokeColor;
                targetCtx.lineWidth = 0.5;
                const cX = screenPos.x;
                const cY = screenPos.y + (tileHeight / 2);
                const origin = { x: cX, y: cY - tileHeight / 2 };
                const vU = { x: tileWidth / 2, y: tileHeight / 2 };
                const vV = { x: -tileWidth / 2, y: tileHeight / 2 };
                const getP = (u, v) => ({ x: origin.x + u * vU.x + v * vV.x, y: origin.y + u * vU.y + v * vV.y });
                const corners = [getP(0, 0), getP(1, 0), getP(1, 1), getP(0, 1)];
                targetCtx.beginPath();
                targetCtx.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < 4; i++) targetCtx.lineTo(corners[i].x, corners[i].y);
                targetCtx.closePath();
                targetCtx.stroke();

                // --- NEW GUARD: STOP HERE IF DIMMED ---
                // We have drawn the grid stroke (3156) and the base fill (above).
                // If this tile is dimmed (Rule Active + Not Highlighted), we stop here.
                // This ensures it looks EXACTLY like an empty grid tile.
                if (getEffectiveHighlightRule() && !isHigh) {
                    continue;
                }

                let tileColor = zone.color;
                let plotAlpha = 1.0;

                if (getEffectiveHighlightRule() && isHigh) {
                    // Logic: Don't brighten "Door Source" plots, only the buildings themselves
                    const isDoorSource = getEffectiveHighlightRule() === 'doorCreation' &&
                        (plot.name !== 'EXISTING' && zone.name !== 'EXISTING_HOUSING');

                    if (!isDoorSource) {
                        tileColor = lightenColor(tileColor, 50); // Brighten highlighted elements
                    }

                    // Special Highlight for Buffer Zones (Empty AND Occupied Plots)
                    // Unified Amber Color
                    if ((getEffectiveHighlightRule() === 'workshopDistance' && hasExistingNeighbor(x, y, 2)) ||
                        (getEffectiveHighlightRule() === 'sportDistance' && hasExistingNeighbor(x, y, 1))) {
                        tileColor = '#FFAB00'; // Amber (Unified)
                    }
                }

                drawTile(tileColor);

                if (plot.name !== 'EMPTY') {
                    // GREEN ZONE COMPLIANCE SUPPRESSION (Pass 1 - Plot Layer)
                    // If rule is active, suppress Plot Layer for non-Workshop plots to show the Zone Layer beneath.
                    // This hides Farming ground, Sport ground, and Green plot variations.
                    if (getEffectiveHighlightRule() === 'greenZoneCompliance') {
                        if (plot.name === 'FARMING' || plot.name === 'SPORT' || plot.name === 'GREEN') {
                            continue; // Skip to next plot (Zone layer already drawn at line 3482)
                        }
                    }

                    // RECREATIONAL BUFFER (sportDistance) SUPPRESSION
                    // strict: "farming plots ... showing (but shouldn't)"
                    if (getEffectiveHighlightRule() === 'sportDistance') {
                        if (plot.name === 'FARMING') continue;
                    }

                    if (zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {
                        let pColor = plot.color;

                        // Workshop "Social" Skin Ground Color Override
                        if (plot.name === 'WORKSHOP') {
                            const wLayout = workshopLayouts.get(`${x},${y}`);
                            if (wLayout && wLayout.variant === 1) { // Variant 1 is Social
                                pColor = '#FFE8C2'; // Significantly Lighter version of #FFCB77
                            }
                        }

                        // BUFFER COLOR OVERRIDE: MOVED DOWN
                        // (Was here)

                        // SKIN LOGIC: Override Color for Sport Variants
                        if (plot.name === 'SPORT') {
                            const layout = sportLayouts.get(`${x},${y}`);
                            let pVariant = 0;
                            if (layout) {
                                pVariant = layout.variant;
                            } else {
                                // Fallback (should not happen if pre-calc is correct)
                                const seed = (x * 492 + y * 821);
                                const randomVar = Math.floor(Math.abs(Math.sin(seed) * 1000)) % 3;
                                pVariant = 0; // Fix: Default to Soccer (0) to match Pass 2 fallback, effectively forcing Light Blue
                            }

                            // User Request: "Only soccer courts should have the slightly lighter blue"
                            // 0: Soccer -> Lighter Blue (#A9D8E6)
                            // 1: Basketball -> Standard Blue (#85C1E9)
                            // 2: Workout -> Standard Blue (#85C1E9)
                            // 3: Tennis -> Orange Tarmac (#E67E22)
                            if (pVariant === 0) pColor = '#A9D8E6'; // Lighter Blue
                            else if (pVariant === 3) pColor = '#E67E22'; // Orange Tarmac
                            else pColor = '#85C1E9'; // Standard Blue
                        }
                        if (getEffectiveHighlightRule() && isHigh) {
                            pColor = lightenColor(pColor, 30);
                        }

                        // BUFFER COLOR OVERRIDE: Force Plot Ground Color to Buffer Color
                        // MOVED TO END to ensure it overrides all other shading (variants, lightening, etc.)
                        if (getEffectiveHighlightRule() && isHigh) {
                            if ((getEffectiveHighlightRule() === 'workshopDistance' && hasExistingNeighbor(x, y, 2)) ||
                                (getEffectiveHighlightRule() === 'sportDistance' && hasExistingNeighbor(x, y, 1))) {
                                pColor = '#FFAB00'; // Amber
                            }
                        }

                        if (isEditMode) {
                            // 1. Draw Base Zone Color
                            drawTile(zone.color);

                            // 2. If occupied, draw a smaller "inner" tile to indicate presence of a plot
                            // This keeps the Zone clearly visible as the border
                            if (backgroundImage) {
                                // If background mode, keep it subtle
                                drawTile(hexToRgba(pColor, 0.5), 0, 'rgba(0,0,0,0)', 0.6);
                            }
                            // SPECIAL CASE: Post-Simulation Existing Buildings -> Show as Full Solid Grey Tile
                            else if (simulationHasRun && (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING')) {
                                drawTile('#E5E5E5', 0, 'rgba(0,0,0,0)', 1.0); // Full Light Grey
                            }
                            else {
                                // Standard Edit Mode: Clear distinction
                                // Draw a scaled down tile (0.6 scale) as small diamond "dot"
                                drawTile(pColor, 0, 'rgba(0,0,0,0)', 0.6);
                            }
                        } else {
                            // SQUISH CALCULATION and PATH DRAWING MOVED TO TOP OF LOOP


                            // PATH DRAWING MOVED TO TOP OF LOOP (Lines 2240+)


                            if (plot.name !== 'FARMING') {
                                // if ((plot.decayStage || 0) > 0) targetCtx.globalAlpha = 0.2; // REMOVED Transparency
                                if ((plot.decayStage || 0) > 0) pColor = darkenColor(pColor, 35); // Apply Darkening
                                drawTile(pColor);
                                targetCtx.globalAlpha = 1.0;

                                // NEW: Garden Pavement (Pass 1 - Ground)
                                // Standardize Garden Variant (1) to draw paved sections on the ground layer
                                // so shadows (Pass 2) render ON TOP of them.
                                let pVariant = (plot.variant !== undefined) ? plot.variant : 0;
                                if (plot.name !== 'GREEN') pVariant = 0; // Force Park for non-Green

                                // NEW: Workshop Pavement (Pass 1)
                                if (plot.name === 'WORKSHOP' && !plot.mergedWith && !isEditMode && !isBufferSuppressed()) {
                                    const layout = workshopLayouts.get(`${x},${y}`);
                                    const wVariant = layout ? layout.variant : 0;
                                    const wRotation = layout ? layout.rotation : 0;
                                    let pavedIndices = [];

                                    // Define Paved Indices based on Skin
                                    if (wVariant === 0) {
                                        // Garage: Pave front of door (Index 7, assuming Building at 1,4)
                                        pavedIndices = [7];
                                    } else if (wVariant === 1) {
                                        // Social: Path to door (Indices 2, 5, assuming Building at 0,1,3,4)
                                        pavedIndices = [2, 5];
                                    } else if (wVariant === 2) {
                                        // Actual: 2/3 paved (Bottom 2 rows: 3,4,5, 6,7,8)
                                        pavedIndices = [3, 4, 5, 6, 7, 8];
                                    }

                                    if (pavedIndices.length > 0) {
                                        targetCtx.fillStyle = '#E6E2D3'; // Same Garden Pavement Color

                                        pavedIndices.forEach(posIndex => {
                                            // 1. Logical Position
                                            const lRow = Math.floor(posIndex / 3);
                                            const lCol = posIndex % 3;
                                            // 2. Center-Relative
                                            const lSubX = lCol - 1;
                                            const lSubY = lRow - 1;
                                            // 3. Apply Rotation
                                            let rx = lSubX;
                                            let ry = lSubY;
                                            const turns = wRotation % 4;
                                            for (let t = 0; t < turns; t++) {
                                                const tmp = rx;
                                                rx = -ry;
                                                ry = tmp;
                                            }
                                            // 4. Screen Offset
                                            const offsetX = rx * (tileWidth / 6) + ry * (-tileWidth / 6);
                                            const offsetY = rx * (tileHeight / 6) + ry * (tileHeight / 6);
                                            const px = screenPos.x + offsetX;
                                            const py = screenPos.y + tileHeight / 2 + offsetY;

                                            // Draw Square Tile (Rhombus)
                                            const sw = tileWidth / 3;
                                            const sh = tileHeight / 3;
                                            targetCtx.beginPath();
                                            targetCtx.moveTo(px, py - sh / 2);
                                            targetCtx.lineTo(px + sw / 2, py);
                                            targetCtx.lineTo(px, py + sh / 2);
                                            targetCtx.lineTo(px - sw / 2, py);
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                        });
                                    }
                                }
                                if (plot.name === 'GREEN' && pVariant === 1 && !isEditMode) {
                                    // Garden Layout: Indices 5 and 8 are Paved
                                    // Pavement Suppression in Buffers
                                    if (!isBufferSuppressed()) {
                                        // We need to calculate their positions.
                                        // Reuse Rotation Logic
                                        const rot = (plot.rotation !== undefined) ? plot.rotation : ((x * 7 + y * 13) % 4);
                                        const pavedIndices = [5, 8];

                                        targetCtx.fillStyle = '#E6E2D3'; // Paved Color

                                        pavedIndices.forEach(posIndex => {
                                            // 1. Logical Position (Layout Space)
                                            const lRow = Math.floor(posIndex / 3);
                                            const lCol = posIndex % 3;

                                            // 2. Center-Relative Coordinates (Layout Space)
                                            const lSubX = lCol - 1;
                                            const lSubY = lRow - 1;

                                            // 3. Apply Rotation (0, 90, 180, 270 deg clockwise)
                                            let rx = lSubX;
                                            let ry = lSubY;
                                            const turns = rot % 4;
                                            for (let t = 0; t < turns; t++) {
                                                const tmp = rx;
                                                rx = -ry;
                                                ry = tmp;
                                            }

                                            // 4. Calculate Final Screen Offset
                                            // Note: tileWidth/6 is the step size for 3x3 grid centered
                                            const offsetX = rx * (tileWidth / 6) + ry * (-tileWidth / 6);
                                            const offsetY = rx * (tileHeight / 6) + ry * (tileHeight / 6);

                                            const px = screenPos.x + offsetX;
                                            const py = screenPos.y + tileHeight / 2 + offsetY;

                                            // Draw Square Tile (Rhombus)
                                            const sw = tileWidth / 3;
                                            const sh = tileHeight / 3;

                                            targetCtx.beginPath();
                                            targetCtx.moveTo(px, py - sh / 2);
                                            targetCtx.lineTo(px + sw / 2, py);
                                            targetCtx.lineTo(px, py + sh / 2);
                                            targetCtx.lineTo(px - sw / 2, py);
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                            targetCtx.fill();
                                        });
                                    }
                                }

                                // DRAW SPORT GROUND MARKINGS (Pass 1 - Flat)
                                if (plot.name === 'SPORT') {
                                    // VISUAL FIX: Hide markings in Industrial Buffer Zone to reduce yellow clutter
                                    if (getEffectiveHighlightRule() === 'workshopDistance') continue; // Skip markings

                                    const layout = sportLayouts.get(`${x},${y}`);
                                    const pVariant = layout ? layout.variant : 0;
                                    const pRotation = layout ? layout.rotation : 0;
                                    drawSportGround(targetCtx, screenPos.x, screenPos.y, tileWidth, tileHeight, pVariant, pRotation, squish);
                                }
                            }
                        }

                    } else if (zone.name === 'EXISTING_HOUSING') {
                        // Always show gray buildings in EXISTING_HOUSING zones
                        // Force Black Outline for White Zone
                        let pColor = plotTypes.EXISTING.color;
                        if (getEffectiveHighlightRule() && isHigh) {
                            pColor = lightenColor(pColor, 30);
                        }
                        if (!getEffectiveHighlightRule() || isHigh) {
                            // EXISTING force black stroke already, but maybe thicker if hovered?
                            // Existing logic passed hardcoded '#000000'.
                            // If hovered, we want 3.0 width.
                            drawTile(pColor, 1.0, '#000000', 1.0, { l: 0, r: 0, t: 0, b: 0 }, tileLineWidth);
                        }
                    }
                } else if (zone.name === 'EXISTING_HOUSING') {
                    // Show gray for empty EXISTING_HOUSING zones too
                    // Force Black Outline for White Zone
                    let pColor = plotTypes.EXISTING.color;
                    if (getEffectiveHighlightRule() && isHigh) {
                        pColor = lightenColor(pColor, 30);
                    }
                    if (!getEffectiveHighlightRule() || isHigh) {
                        // Same here for empty existing zones
                        drawTile(pColor, 1.0, '#000000', 1.0, { l: 0, r: 0, t: 0, b: 0 }, tileLineWidth);
                    }
                }
                if (zone.name === 'SKELETON') {
                    // Skeleton already drawn by zone.color base above?
                    // Verify: Line 1859 draws zone.color. Line 1887 draws it again?
                    // Original code had drawTile(zone.color) at 1859 AND at 1887 for Skeleton.
                    // We replaced 1859.
                    // We should trust the logic above.
                }

                // FREEZE OVERLAY (Export)
                if (freezeGrid[y] && freezeGrid[y][x]) {
                    drawTile('rgba(33, 150, 243, 0.15)', 0, 'rgba(33, 150, 243, 0.4)', 1.0, { l: 0, r: 0, t: 0, b: 0 }, 1.5);
                }
            }
        }

        // 2. UNIFIED 3D OBJECTS

        // We collect all 3D drawing commands into a list and sort them by depth (x + y)
        // to ensure correct occlusion between different types of objects.

        // (renderList cleared at top of function)

        // 1.5. ADD COLOR "DOORMATS" TO RENDER LIST
        // Draw colored patches on EXISTING buildings where doors connect to plots
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                const zone = zoneGrid[y][x];

                // Only process EXISTING buildings
                if (!plot || (plot.name !== 'EXISTING' && zone.name !== 'EXISTING_HOUSING')) continue;

                // VISUAL RULE: Show "Door Steps" if NO rule is active OR if Door Creation Rule is active
                // Hide them only if a DIFFERENT rule is active (e.g., Tree Donation)
                if (getEffectiveHighlightRule() && getEffectiveHighlightRule() !== 'doorCreation') continue;

                const screenPos = isoToScreen(x, y);
                const depth = x + y - 0.1; // Draw underneath building base (EXISTING depth is x+y)

                // Check all four faces for doors
                const faces = [
                    { dx: -1, dy: 0, face: 'left' },
                    { dx: 1, dy: 0, face: 'right' },
                    { dx: 0, dy: -1, face: 'top' },
                    { dx: 0, dy: 1, face: 'bottom' }
                ];

                // Find ONE neighbor color to invoke doormat (prevent overlapping)
                // Actually - iterate ALL faces to support multiple functional doormats
                faces.forEach(({ dx, dy, face }) => {
                    if (hasDoor(dataGrid, x, y, face)) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < numCols && ny >= 0 && ny < numRows) {
                            const neighbor = dataGrid[ny][nx];
                            if (neighbor && neighbor.name !== 'EMPTY' && neighbor.name !== 'EXISTING') {
                                const doormatColor = neighbor.color || plotTypes[neighbor.name].color;

                                renderList.push({
                                    isHighlighted: false,
                                    depth: depth,
                                    type: 'DOOR_MAT',
                                    draw: () => {
                                        const originX = screenPos.x;
                                        const originY = screenPos.y;
                                        const vUx = tileWidth / 2;
                                        const vUy = tileHeight / 2;
                                        const vVx = -tileWidth / 2;
                                        const vVy = tileHeight / 2;

                                        // Force full opacity
                                        let finalColor = doormatColor;
                                        if (finalColor.startsWith('rgba')) {
                                            finalColor = finalColor.replace(/[\d\.]+\)$/, '1.0)');
                                        } else if (finalColor.startsWith('#') && finalColor.length === 9) {
                                            finalColor = finalColor.substring(0, 7);
                                        }

                                        targetCtx.save();
                                        targetCtx.globalAlpha = 1.0;
                                        targetCtx.fillStyle = finalColor;
                                        targetCtx.beginPath();

                                        // Doormat Geometry Parameters
                                        // We want a mat centered on the edge, extending inwards
                                        const start = 0.0; // Start 0% along the edge - FULL WIDTH
                                        const end = 1.0;   // End 100% along the edge - FULL WIDTH
                                        const inset = 0.25; // Extend 25% into the tile

                                        // Function to get screen point for (u,v)
                                        const getP = (u, v) => ({
                                            x: originX + u * vUx + v * vVx,
                                            y: originY + u * vUy + v * vVy
                                        });

                                        let p1, p2, p3, p4;

                                        // Note: u axis (Top->Right), v axis (Top->Left)
                                        // u=1 Edge (Right): From (1,0) to (1,1). Faces Right Neighbor (x+1).
                                        // u=0 Edge (Left): From (0,0) to (0,1). Faces Left Neighbor (x-1).
                                        // v=1 Edge (Bottom): From (0,1) to (1,1). Faces Bottom Neighbor (y+1).
                                        // v=0 Edge (Top): From (0,0) to (1,0). Faces Top Neighbor (y-1).

                                        if (dx === 1) { // Right Neighbor -> u=1 Edge
                                            p1 = getP(1.0, start);     // Outer Edge Start
                                            p2 = getP(1.0, end);       // Outer Edge End
                                            p3 = getP(1.0 - inset, end); // Inner Edge End
                                            p4 = getP(1.0 - inset, start); // Inner Edge Start
                                        }
                                        else if (dx === -1) { // Left Neighbor -> u=0 Edge
                                            p1 = getP(0.0, start);     // Outer Edge Start
                                            p2 = getP(0.0, end);       // Outer Edge End
                                            p3 = getP(inset, end);     // Inner Edge End
                                            p4 = getP(inset, start);   // Inner Edge Start
                                        }
                                        else if (dy === 1) { // Bottom Neighbor -> v=1 Edge
                                            p1 = getP(start, 1.0);     // Outer Edge Start
                                            p2 = getP(end, 1.0);       // Outer Edge End
                                            p3 = getP(end, 1.0 - inset); // Inner Edge End
                                            p4 = getP(start, 1.0 - inset); // Inner Edge Start
                                        }
                                        else if (dy === -1) { // Top Neighbor -> v=0 Edge
                                            p1 = getP(start, 0.0);   // Outer Edge Start
                                            p2 = getP(end, 0.0);     // Outer Edge End
                                            p3 = getP(end, inset);   // Inner Edge End
                                            p4 = getP(start, inset); // Inner Edge Start
                                        }

                                        if (p1) {
                                            targetCtx.moveTo(p1.x, p1.y);
                                            targetCtx.lineTo(p2.x, p2.y);
                                            targetCtx.lineTo(p3.x, p3.y);
                                            targetCtx.lineTo(p4.x, p4.y);
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                        }

                                        targetCtx.restore();
                                    }
                                });
                            }
                        }
                    }
                });
            }
        }

        // 2. Pre-calculate merged existing building geometry
        // Also calculate in edit mode before simulation has run (for instant 3D visualization)
        const shouldShowExisting3D = !isEditMode || !simulationHasRun;
        const existingGroups = shouldShowExisting3D ? findConnectedExistingBuildings() : [];
        const mergedCellsMap = new Map(); // key `${x},${y}` -> { geometry, group }

        if (shouldShowExisting3D) {
            const lightGrey = '#FFFFFF';
            const blockZ = tileHeight * 1.8;
            const inset = 0.15;
            // Vectors for the two axes of the isometric tile
            const v_u = { x: tileWidth / 2, y: tileHeight / 2 };     // u-axis: Top -> Right
            const v_v = { x: -tileWidth / 2, y: tileHeight / 2 };    // v-axis: Top -> Left

            for (const group of existingGroups) {
                for (const { x, y } of group.cells) {
                    const screenPos = isoToScreen(x, y);
                    // Determine Highlighting for this cell
                    const isHigh = isHighlighted(x, y, dataGrid[y][x], zoneGrid[y][x]);

                    const T_orig = { x: screenPos.x, y: screenPos.y };

                    const hasNeighbor = (dx, dy) => group.cellsSet.has(`${x + dx},${y + dy}`);

                    // Calculate UV insets based on neighbors
                    const u_min = hasNeighbor(-1, 0) ? 0 : inset;
                    const u_max = hasNeighbor(1, 0) ? 1 : 1 - inset;
                    const v_min = hasNeighbor(0, -1) ? 0 : inset;
                    const v_max = hasNeighbor(0, 1) ? 1 : 1 - inset;

                    // Helper to map UV to Screen
                    const getP = (u, v) => ({
                        x: T_orig.x + u * v_u.x + v * v_v.x,
                        y: T_orig.y + u * v_u.y + v * v_v.y
                    });

                    const cT = getP(u_min, v_min);
                    const cR = getP(u_max, v_min);
                    const cB = getP(u_max, v_max);
                    const cL = getP(u_min, v_max);

                    // Determine exposed faces for wall rendering
                    const isExposedL = u_min !== 0;
                    const isExposedR = u_max !== 1;
                    const isExposedT = v_min !== 0;
                    const isExposedB = v_max !== 1;

                    mergedCellsMap.set(`${x},${y}`, {
                        group,
                        geometry: { x, y, cT, cR, cB, cL, isExposedL, isExposedR, isExposedT, isExposedB }
                    });
                }
            }
        }

        // PASS 1.5: DRAW PATHS (Overlay for Persistence & Visibility)
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const plot = dataGrid[y][x];
                if (!plot || !plot.paths) continue;

                // View Culling check (reuse same margin)
                const screenPos = isoToScreen(x, y);
                const margin = tileHeight * 6; // Generous margin for tall buildings/shadows
                const left = screenPos.x - tileWidth / 2 - margin;
                const right = screenPos.x + tileWidth / 2 + margin;
                const top = screenPos.y - margin;
                const bottom = screenPos.y + tileHeight + margin;

                // Very loose cull for performance (especially with shadows it's tricky)
                // Use logicalWidth/Height to ensure we don't cull visible items in Pixel Mode
                if (right < 0 || left > logicalWidth || bottom < 0 || top > logicalHeight) {
                    continue; // Skip
                }

                // Check highlight state for paths
                const zone = zoneGrid[y][x];
                const isHigh = isHighlighted(x, y, plot, zone);

                // Skip rendering paths unless rightOfWay (buildingRoadConstraint) rule is active
                const rule = getEffectiveHighlightRule();
                if (rule && rule !== 'buildingRoadConstraint') {
                    continue; // Hide paths for all rules except rightOfWay
                }

                let pathColor = '#A1887F'; // Warmer Brown to fix "Grey" issue

                // Brighten if highlighted
                if (getEffectiveHighlightRule() && isHigh) {
                    pathColor = lightenColor(pathColor, 30);
                }

                targetCtx.fillStyle = pathColor;

                // Pre-calculate shared geometry values
                const cX = screenPos.x;
                const cY = screenPos.y + tileHeight / 2;
                const originX = cX;
                const originY = cY - tileHeight / 2;
                const vUx = tileWidth / 2;
                const vUy = tileHeight / 2;
                const vVx = -tileWidth / 2;
                const vVy = tileHeight / 2;

                if (plot.paths.right) {
                    // Right Edge: u=1. Gap Filling: u=0.87 to u=1.13
                    // Inline coordinate calculations
                    const c1x = originX + 0.87 * vUx, c1y = originY + 0.87 * vUy;
                    const c2x = originX + 1.13 * vUx, c2y = originY + 1.13 * vUy;
                    const c3x = originX + 1.13 * vUx + 1.0 * vVx, c3y = originY + 1.13 * vUy + 1.0 * vVy;
                    const c4x = originX + 0.87 * vUx + 1.0 * vVx, c4y = originY + 0.87 * vUy + 1.0 * vVy;

                    targetCtx.beginPath();
                    targetCtx.moveTo(c1x, c1y);
                    targetCtx.lineTo(c2x, c2y);
                    targetCtx.lineTo(c3x, c3y);
                    targetCtx.lineTo(c4x, c4y);
                    targetCtx.fill();
                }
                if (plot.paths.bottom) {
                    // Bottom Edge: v=1. Gap Filling: v=0.87 to v=1.13
                    // Inline coordinate calculations
                    const c1x = originX + 0.87 * vVx, c1y = originY + 0.87 * vVy;
                    const c2x = originX + 1.0 * vUx + 0.87 * vVx, c2y = originY + 1.0 * vUy + 0.87 * vVy;
                    const c3x = originX + 1.0 * vUx + 1.13 * vVx, c3y = originY + 1.0 * vUy + 1.13 * vVy;
                    const c4x = originX + 1.13 * vVx, c4y = originY + 1.13 * vVy;

                    targetCtx.beginPath();
                    targetCtx.moveTo(c1x, c1y);
                    targetCtx.lineTo(c2x, c2y);
                    targetCtx.lineTo(c3x, c3y);
                    targetCtx.lineTo(c4x, c4y);
                    targetCtx.fill();
                }
            }
        }

        // HOISTED SHADOW HELPER
        const getShadowShift = (z) => {
            const sx = z * 1.0;
            const sy = sx * 0.5 + z;
            return { x: sx, y: sy };
        };

        // 1.8 PRE-CALCULATE SHADOW POLYGONS FOR TREE CHECK
        const shadowPolygons = [];
        if (showShadows && !isEditMode) {
            // A. MERGED EXISTING HOUSING
            if (typeof mergedCellsMap !== 'undefined') {
                for (const [key, val] of mergedCellsMap.entries()) {
                    const { geometry } = val;
                    const { cT, cR, cB, cL } = geometry;
                    const blockZ = tileHeight * 1.8;
                    const s = getShadowShift(blockZ);
                    const sx = s.x;
                    const sy_ground = sx * 0.5;

                    const pL = { x: cL.x + sx, y: cL.y + sy_ground };
                    const pB = { x: cB.x + sx, y: cB.y + sy_ground };
                    const pR = { x: cR.x + sx, y: cR.y + sy_ground };
                    const pT = { x: cT.x + sx, y: cT.y + sy_ground };

                    shadowPolygons.push([cL, cB, cR, pR, pT, pL]);
                }
            }

            // B. WORKSHOPS / FARMING (Single & Quadrants)
            for (let y = 0; y < numRows; y++) {
                for (let x = 0; x < numCols; x++) {
                    const plot = dataGrid[y][x];
                    if (!plot) continue;

                    if ((plot.name === 'WORKSHOP' || plot.name === 'FARMING') && !plot.mergedWith && plot.occupiedQuad !== undefined) {
                        const quadrant = plot.occupiedQuad;
                        const bWidth = tileWidth * 0.33;
                        const bHeight = tileHeight * 0.33;
                        const blockZ = tileHeight * 0.6;
                        let offsetX = 0, offsetY = 0;
                        if (quadrant === 0) { offsetX = 0; offsetY = -tileHeight / 3; }
                        if (quadrant === 1) { offsetX = tileWidth / 3; offsetY = 0; }
                        if (quadrant === 2) { offsetX = 0; offsetY = tileHeight / 3; }
                        if (quadrant === 3) { offsetX = -tileWidth / 3; offsetY = 0; }

                        const sPos = isoToScreen(x, y);
                        const startX = sPos.x + offsetX;
                        const startY = sPos.y + tileHeight / 2 + offsetY - (bHeight / 2);

                        const bTop = { x: startX, y: startY };
                        const bRight = { x: startX + bWidth / 2, y: startY + bHeight / 2 };
                        const bBottom = { x: startX, y: startY + bHeight };
                        const bLeft = { x: startX - bWidth / 2, y: startY + bHeight / 2 };

                        const s = getShadowShift(blockZ);
                        const sx = s.x;
                        const sy_ground = sx * 0.5;

                        const pL = { x: bLeft.x + sx, y: bLeft.y + sy_ground };
                        const pR = { x: bRight.x + sx, y: bRight.y + sy_ground };
                        const pT = { x: bTop.x + sx, y: bTop.y + sy_ground };

                        shadowPolygons.push([bLeft, bBottom, bRight, pR, pT, pL]);
                    }
                    else if (plot.isMergeMaster && plot.mergedWith) {
                        // Merged Greenhouses / Workshops
                        // Simplified Block Shadow approximation
                        const sPos = isoToScreen(x, y);
                        const pPos = isoToScreen(plot.mergedWith.x, plot.mergedWith.y);

                        // Determine Center of Merged Block approx
                        const cx = (sPos.x + pPos.x) / 2;
                        const cy = (sPos.y + pPos.y) / 2;

                        // Large Block (2 tiles roughly)
                        const blockZ = tileHeight * 1.5;
                        const s = getShadowShift(blockZ);
                        const sx = s.x;
                        const sy_ground = sx * 0.5;

                        // Very rough bounding box
                        const size = tileWidth;
                        const p1 = { x: cx - size, y: cy + tileHeight / 2 };
                        const p2 = { x: cx + size, y: cy + tileHeight / 2 };
                        const p3 = { x: cx + size + sx, y: cy + tileHeight / 2 + sy_ground - blockZ }; // Peak
                        const p4 = { x: cx - size + sx, y: cy + tileHeight / 2 + sy_ground - blockZ };

                        shadowPolygons.push([p1, p2, p3, p4]);
                    }
                }
            }
        }

        // 2. Iterate grid to build render list

        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const depth = x + y;
                const plot = dataGrid[y][x];
                const zone = zoneGrid[y][x];
                const screenPos = isoToScreen(x, y);

                // PERFORMANCE OPTIMIZATION: View Frustum Culling
                // Skip tiles well outside the visible canvas
                const cullMargin = tileHeight * 6; // Generous margin for tall buildings/shadows
                // Fix: Use LOGICAL dimensions
                if (screenPos.x < -cullMargin || screenPos.x > logicalWidth + cullMargin ||
                    screenPos.y < -cullMargin || screenPos.y > logicalHeight + cullMargin) {
                    continue;
                }

                const isHigh = plot._cachedHighlight || false; // Use cached value from Pass 1

                // Buffer Rule Suppression Helper (Pass 2 Definition)
                const isBufferSuppressed = () => {
                    if ((getEffectiveHighlightRule() === 'workshopDistance' || getEffectiveHighlightRule() === 'sportDistance') && isHigh) {
                        if (getEffectiveHighlightRule() === 'workshopDistance' && plot.name === 'WORKSHOP') return false;
                        if (getEffectiveHighlightRule() === 'sportDistance' && plot.name === 'SPORT') return false;
                        return true;
                    }
                    return false;
                };

                // SQUISH CALCULATION (Repeated for Pass 2)
                const squish = { l: 0, r: 0, t: 0, b: 0 };
                if (plot.paths) {
                    if (plot.paths.right) squish.r = 0.13; // Updated to match new path width
                    if (plot.paths.bottom) squish.b = 0.13; // Updated to match new path width
                }
                if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) squish.l = 0.13; // Updated to match new path width
                if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) squish.t = 0.13; // Updated to match new path width

                // Determine if this is an existing building zone that should show 3D before simulation
                const isExistingBuildingZone = (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING');
                const shouldEnter3DBlock = !isEditMode || (isExistingBuildingZone && !simulationHasRun);

                if (shouldEnter3DBlock && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {

                    // SHADOW HELPERS (Hoisted to top of drawScene)

                    const shadowColor = 'rgba(0, 0, 0, 0.2)';
                    const shadowNoStroke = 'rgba(0,0,0,0)'; // Transparent stroke



                    // HEDGES
                    // Only draw hedges for new construction, not for EXISTING buildings
                    if (showObjects && plot.name !== 'EMPTY' && plot.name !== 'EXISTING' && zone.name !== 'EXISTING_HOUSING') {
                        // Skip if rule is active and plot is not highlighted
                        const isHigh = plot._cachedHighlight || false; // Use cached value
                        if (getEffectiveHighlightRule() && !isHigh) {
                            continue; // Skip hedge rendering for non-highlighted plots
                        }

                        const hedgeHeight = tileHeight * 0.2;
                        const lowHedgeHeight = tileHeight * 0.08; // Low hedge for Green neighbors
                        let baseColor = '#7a9b7c'; // Default Green
                        if (plot.name === 'WORKSHOP') baseColor = '#8D7F71'; // Workshop Fence (Grey-Brown)

                        // DECAY LOGIC: Darken Hedges
                        if ((plot.decayStage || 0) > 0) {
                            baseColor = darkenColor(baseColor, 35);
                        }

                        // Define Shades
                        const hedgeMedium = darkenColor(baseColor, 10);
                        const hedgeDark = darkenColor(baseColor, 20);

                        const drawHedgeFn = (x1, y1, x2, y2, color, h, shortenStart = false, shortenEnd = false) => {
                            targetCtx.fillStyle = color;
                            targetCtx.beginPath();

                            // Shorten Logic
                            let sx = x1, sy = y1, ex = x2, ey = y2;
                            const shortenLen = tileWidth * 0.1; // Reduced from 0.25 to extend closer to path

                            if (shortenStart) {
                                const dx = x2 - x1;
                                const dy = y2 - y1;
                                const len = Math.hypot(dx, dy);
                                if (len > 0) {
                                    const u = shortenLen / len;
                                    sx = x1 + dx * u;
                                    sy = y1 + dy * u;
                                }
                            }
                            if (shortenEnd) {
                                const dx = x2 - x1;
                                const dy = y2 - y1;
                                const len = Math.hypot(dx, dy);
                                if (len > 0) {
                                    const u = shortenLen / len;
                                    ex = x2 - dx * u;
                                    ey = y2 - dy * u;
                                }
                            }

                            targetCtx.moveTo(sx, sy);
                            targetCtx.lineTo(ex, ey);
                            targetCtx.lineTo(ex, ey - h);
                            targetCtx.lineTo(sx, sy - h);
                            targetCtx.closePath();
                            targetCtx.fill();
                        };
                        const top = { x: screenPos.x, y: screenPos.y };
                        const right = { x: screenPos.x + tileWidth / 2, y: screenPos.y + tileHeight / 2 };
                        const bottom = { x: screenPos.x, y: screenPos.y + tileHeight };
                        const left = { x: screenPos.x - tileWidth / 2, y: screenPos.y + tileHeight / 2 };

                        const getHedgeInfo = (dx, dy) => {
                            const nx = x + dx, ny = y + dy;
                            // Map Boundary: Draw normal hedge
                            if (nx < 0 || nx >= numCols || ny < 0 || ny >= numRows) return { draw: true, height: hedgeHeight };

                            const neighborPlot = dataGrid[ny][nx];
                            const neighborZone = zoneGrid[ny][nx];

                            // No hedge against Skeleton (Roads)
                            if (neighborZone.name === 'SKELETON') return { draw: false, height: 0 };

                            // Special Rule 1: Green next to Green gets Low Hedge
                            if (plot.name === 'GREEN' && neighborPlot.name === 'GREEN') {
                                return { draw: true, height: lowHedgeHeight };
                            }
                            // Special Rule 1b: Farming next to Farming gets Low Hedge (Requested)
                            if (plot.name === 'FARMING' && neighborPlot.name === 'FARMING') {
                                return { draw: true, height: lowHedgeHeight };
                            }

                            // Special Rule 2: Workshop next to Workshop gets Low Fence
                            if (plot.name === 'WORKSHOP' && neighborPlot.name === 'WORKSHOP') {
                                // Exception: Merged Workshops get No Fence
                                if (plot.mergedWith && plot.mergedWith.x === nx && plot.mergedWith.y === ny) {
                                    return { draw: false, height: 0 };
                                }
                                return { draw: true, height: lowHedgeHeight };
                            }

                            // Normal Rule: Same type (non-Green) gets No Hedge
                            if (neighborPlot.name === plot.name) return { draw: false, height: 0 };

                            // Different type: Normal Hedge
                            return { draw: true, height: hedgeHeight };
                        };

                        // Split Hedges separate depths
                        // Top/Left = Back (depth - 0.45)
                        // Bottom/Right = Front (depth + 0.45)

                        // Helper: Check if a path exists on a specific RELATIVE edge
                        // e.g. Left Edge (dx=-1) -> check Left Neighbor's Right Path
                        const checkPath = (dx, dy) => {
                            const nx = x + dx, ny = y + dy;
                            if (dx === -1) return nx >= 0 && nx < numCols && dataGrid[y][nx].paths && dataGrid[y][nx].paths.right;
                            if (dx === 1) return plot.paths && plot.paths.right;
                            if (dy === -1) return ny >= 0 && ny < numRows && dataGrid[ny][x].paths && dataGrid[ny][x].paths.bottom;
                            if (dy === 1) return plot.paths && plot.paths.bottom;
                            return false;
                        };

                        // Path Check Helper - Suppress Hedge if Path exists ON THAT EDGE
                        const hasPath = (dx, dy) => checkPath(dx, dy);

                        // Door Check Helper - Check if neighbor has a door facing current plot
                        const checkDoor = (dx, dy) => {
                            // Calculate neighbor coordinates
                            const nx = x + dx;
                            const ny = y + dy;

                            // Bounds check
                            if (nx < 0 || nx >= numCols || ny < 0 || ny >= numRows) return false;

                            // Determine which face of the neighbor to check (opposite direction)
                            let face = '';
                            if (dx === -1) face = 'right'; // Left neighbor's right face points at us
                            else if (dx === 1) face = 'left'; // Right neighbor's left face points at us
                            else if (dy === -1) face = 'bottom'; // Top neighbor's bottom face points at us
                            else if (dy === 1) face = 'top'; // Bottom neighbor's top face points at us

                            // Call hasDoor with NEIGHBOR's coordinates to check if they have a door facing us
                            return hasDoor(dataGrid, nx, ny, face);
                        };

                        // isBufferSuppressed is already defined above, reuse it!
                        // GREEN ZONE COMPLIANCE SUPPRESSION (Hedges)
                        if (!isBufferSuppressed() && getEffectiveHighlightRule() !== 'greenZoneCompliance') {
                            const infoL = getHedgeInfo(-1, 0);
                            if (infoL.draw && !checkDoor(-1, 0) && !hasPath(-1, 0)) { // Left Neighbor (Left Edge: Left->Top)
                                renderList.push({ isHighlighted: isHigh, depth: depth - 0.45, type: 'HEDGE', draw: () => drawHedgeFn(left.x, left.y, top.x, top.y, hedgeMedium, infoL.height, checkPath(0, 1), checkPath(0, -1)) });
                            }

                            const infoT = getHedgeInfo(0, -1);
                            if (infoT.draw && !checkDoor(0, -1) && !hasPath(0, -1)) { // Top Neighbor (Top Edge: Top->Right)
                                renderList.push({ isHighlighted: isHigh, depth: depth - 0.45, type: 'HEDGE', draw: () => drawHedgeFn(top.x, top.y, right.x, right.y, hedgeDark, infoT.height, checkPath(-1, 0), checkPath(1, 0)) });
                            }

                            const infoR = getHedgeInfo(1, 0);
                            if (infoR.draw && !checkDoor(1, 0) && !hasPath(1, 0)) { // Right Neighbor (Right Edge: Right->Bottom)
                                renderList.push({ isHighlighted: isHigh, depth: depth + 0.45, type: 'HEDGE', draw: () => drawHedgeFn(right.x, right.y, bottom.x, bottom.y, hedgeMedium, infoR.height, checkPath(0, -1), checkPath(0, 1)) });
                            }

                            const infoB = getHedgeInfo(0, 1);
                            if (infoB.draw && !checkDoor(0, 1) && !hasPath(0, 1)) { // Bottom Neighbor (Bottom Edge: Bottom->Left)
                                renderList.push({ isHighlighted: isHigh, depth: depth + 0.45, type: 'HEDGE', draw: () => drawHedgeFn(bottom.x, bottom.y, left.x, left.y, hedgeDark, infoB.height, checkPath(1, 0), checkPath(-1, 0)) });
                            }
                        }
                    } // End of Hedge Block

                    // MERGED EXISTING BUILDINGS
                    // Show 3D buildings: Always in simulation mode, OR in edit mode before simulation has run
                    const isExistingZone = plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING';
                    const showExisting3D = showObjects && isExistingZone && mergedCellsMap.has(`${x},${y}`) && (!isEditMode || !simulationHasRun);
                    if (showExisting3D) {
                        const { geometry, group } = mergedCellsMap.get(`${x},${y}`);
                        const { cT, cR, cB, cL, isExposedR, isExposedB, isExposedL, isExposedT } = geometry;
                        const blockZ = tileHeight * 1.8;
                        const lightGrey = '#FFFFFF';

                        renderList.push({
                            isHighlighted: isHigh,
                            isDying: (plot.decayStage || 0) > 0,
                            depth,
                            type: 'MERGED_CELL',
                            draw: () => {
                                // Buffer Rule Suppression for Merged Cells (Farming/Workshop)
                                // Hide if in buffer and not the target type.
                                if ((getEffectiveHighlightRule() === 'workshopDistance' || getEffectiveHighlightRule() === 'sportDistance') && isHigh) {
                                    // Allow EXISTING to always show
                                    if (plot.name === 'EXISTING' || zone.name === 'EXISTING_HOUSING') { /* Allow */ }
                                    // Allow Target Types
                                    else if (getEffectiveHighlightRule() === 'workshopDistance' && plot.name === 'WORKSHOP') { /* Allow */ }
                                    else if (getEffectiveHighlightRule() === 'sportDistance' && plot.name === 'SPORT') { /* Allow */ }
                                    else {
                                        return; // Suppress (it's a Farm or other Merged plot in a buffer)
                                    }
                                }

                                // STRICT VISIBILITY: If a rule is active, ONLY show if Highlighted.
                                // This replaces the old hardcoded exclusion list.
                                if (getEffectiveHighlightRule() && !isHigh) return;

                                // --- DRAW ROOF (FLOOR) ---
                                let baseColorString = lightGrey;
                                if (plot.name === 'WORKSHOP') baseColorString = '#FFCB77'; // Workshop Orange
                                else if (plot.name === 'FARMING') baseColorString = '#95D5B2'; // Farming Green

                                // DECAY LOGIC: Darken Base Color if dying
                                if ((plot.decayStage || 0) > 0) {
                                    baseColorString = darkenColor(baseColorString, 35);
                                }

                                let floorColor = lightenColor(baseColorString, 20); // Lighten top face

                                // Score Visualization Overlay for Merged Ground
                                if (visualizeScores) {
                                    const score = plot.value || 0;
                                    const maxScore = 3.0;
                                    const intensity = Math.min(0.7, score / maxScore);
                                    // Darken by intensity
                                    floorColor = darkenColor(floorColor, intensity * 60);
                                }

                                targetCtx.fillStyle = floorColor;

                                targetCtx.beginPath();
                                targetCtx.moveTo(cT.x, cT.y - blockZ);
                                targetCtx.lineTo(cR.x, cR.y - blockZ);
                                targetCtx.lineTo(cB.x, cB.y - blockZ);
                                targetCtx.lineTo(cL.x, cL.y - blockZ);
                                targetCtx.closePath();
                                targetCtx.fill();

                                // --- TOPPING RULE: Roof Garden ---
                                if (plot.hasRoofGarden && simulationRules.toppingRule && (!getEffectiveHighlightRule() || getEffectiveHighlightRule() === 'toppingRule')) {
                                    const gardenOffset = 0;
                                    const gardenZ = blockZ + gardenOffset;

                                    // INSET CALCULATION (15% margin)
                                    const margin = tileWidth * 0.15;
                                    const lerpP = (p1, p2, t) => ({ x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t });

                                    // Center of Roof Base (Logic Coords)
                                    const rcx = (cT.x + cR.x + cB.x + cL.x) / 4;
                                    const rcy = (cT.y + cR.y + cB.y + cL.y) / 4;

                                    const insetFactor = 0.15;
                                    const iT = lerpP(cT, { x: rcx, y: rcy }, insetFactor);
                                    const iR = lerpP(cR, { x: rcx, y: rcy }, insetFactor);
                                    const iB = lerpP(cB, { x: rcx, y: rcy }, insetFactor);
                                    const iL = lerpP(cL, { x: rcx, y: rcy }, insetFactor);

                                    const roofPoly = [iT, iR, iB, iL];

                                    // Determine Variant (Seed) based on position
                                    // FIXED HASH: Use a simpler linear congruential generator to ensure odd/even mix
                                    const seed = ((x * 1664525) + (y * 1013904223)) | 0; // Force 32-bit int
                                    const gVariant = Math.abs(seed) % 3; // 0: Park, 1: Garden, 2: Wilderness

                                    let gColor = '#95D5B2'; // Default Green (Park)

                                    // SKIN LOGIC (Matching Green Plots)
                                    // User Request: "They should just be the same color" to avoid brightness.
                                    // We will use standard Green for all, maybe slight diff.
                                    if (gVariant === 0) gColor = '#95D5B2'; // Standard Park
                                    else if (gVariant === 1) gColor = '#95D5B2'; // Garden (Standard) - Pattern distinguishes it
                                    else if (gVariant === 2) gColor = '#C8E6C9'; // Wilderness - Slightly lighter but not White (#E8F5E9 was too bright)

                                    // Draw Surface
                                    targetCtx.fillStyle = gColor;
                                    targetCtx.beginPath();
                                    targetCtx.moveTo(roofPoly[0].x, roofPoly[0].y - gardenZ);
                                    for (let i = 1; i < roofPoly.length; i++) targetCtx.lineTo(roofPoly[i].x, roofPoly[i].y - gardenZ);
                                    targetCtx.closePath();
                                    targetCtx.fill();

                                    // VARIANT DETAILS
                                    // Variant 1: Garden Paved Pattern (Diamonds)
                                    if (gVariant === 1) {
                                        // Draw Paved Diamond Pattern 
                                        // We need to approximate the grid on the roof.
                                        // Simple approach: Draw a cross path and a central param
                                        targetCtx.strokeStyle = '#E6E2D3'; // Paved Color (Light Tan)
                                        targetCtx.lineWidth = 2;

                                        // Cross Paths
                                        targetCtx.beginPath(); targetCtx.moveTo(iT.x, iT.y - gardenZ); targetCtx.lineTo(iB.x, iB.y - gardenZ); targetCtx.stroke();
                                        targetCtx.beginPath(); targetCtx.moveTo(iL.x, iL.y - gardenZ); targetCtx.lineTo(iR.x, iR.y - gardenZ); targetCtx.stroke();

                                        // Central Diamond
                                        const midT = lerpP(iT, { x: rcx, y: rcy }, 0.5);
                                        const midR = lerpP(iR, { x: rcx, y: rcy }, 0.5);
                                        const midB = lerpP(iB, { x: rcx, y: rcy }, 0.5);
                                        const midL = lerpP(iL, { x: rcx, y: rcy }, 0.5);

                                        targetCtx.fillStyle = '#E6E2D3';
                                        targetCtx.beginPath();
                                        targetCtx.moveTo(midT.x, midT.y - gardenZ);
                                        targetCtx.lineTo(midR.x, midR.y - gardenZ);
                                        targetCtx.lineTo(midB.x, midB.y - gardenZ);
                                        targetCtx.lineTo(midL.x, midL.y - gardenZ);
                                        targetCtx.closePath();
                                        targetCtx.fill();
                                    }

                                    // ROOF GARDEN & VEGETATION
                                    const rule = getEffectiveHighlightRule();
                                    const suppressVeg = (rule === 'sportDistance' || rule === 'greenZoneCompliance');
                                    const suppressRoofGarden = (rule === 'sportDistance' || rule === 'doorCreation' || rule === 'farmingNeighbor');

                                    if (!suppressRoofGarden) {
                                        // BORDER LOGIC (Hedge or Fence)
                                        const borderType = (Math.abs(seed) % 2 === 0) ? 'HEDGE' : 'FENCE';

                                        // Fence Vars (Match Workshop)
                                        const fenceColor = '#8D7F71';
                                        const fenceHeight = tileHeight * 0.08;

                                        // Hedge Vars (Standard)
                                        const hedgeColor = '#7a9b7c';
                                        const hedgeHeight = tileHeight * 0.08;

                                        const drawBorderSeg = (p1, p2) => {
                                            if (borderType === 'HEDGE') {
                                                // Draw Box (Wall)
                                                targetCtx.fillStyle = hedgeColor;
                                                targetCtx.beginPath();
                                                targetCtx.moveTo(p1.x, p1.y - gardenZ);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ - hedgeHeight);
                                                targetCtx.lineTo(p1.x, p1.y - gardenZ - hedgeHeight);
                                                targetCtx.closePath();
                                                targetCtx.fill();

                                                // Top Detail
                                                targetCtx.fillStyle = lightenColor(hedgeColor, 15);
                                                targetCtx.beginPath();
                                                targetCtx.moveTo(p1.x, p1.y - gardenZ - hedgeHeight);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ - hedgeHeight);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ - hedgeHeight + 2);
                                                targetCtx.lineTo(p1.x, p1.y - gardenZ - hedgeHeight + 2);
                                                targetCtx.closePath();
                                                targetCtx.fill();
                                            } else {
                                                // FENCE
                                                targetCtx.fillStyle = fenceColor;
                                                targetCtx.beginPath();
                                                targetCtx.moveTo(p1.x, p1.y - gardenZ);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ - fenceHeight);
                                                targetCtx.lineTo(p1.x, p1.y - gardenZ - fenceHeight);
                                                targetCtx.closePath();
                                                targetCtx.fill();

                                                // Rail
                                                targetCtx.strokeStyle = darkenColor(fenceColor, 20);
                                                targetCtx.lineWidth = 1;
                                                targetCtx.beginPath();
                                                targetCtx.moveTo(p1.x, p1.y - gardenZ - fenceHeight);
                                                targetCtx.lineTo(p2.x, p2.y - gardenZ - fenceHeight);
                                                targetCtx.stroke();
                                            }
                                        };

                                        // Draw 4 Borders
                                        drawBorderSeg(iT, iR);
                                        drawBorderSeg(iR, iB);
                                        drawBorderSeg(iB, iL);
                                        drawBorderSeg(iL, iT);

                                        // VEGETATION
                                        // Only draw vegetation if Roof Garden is visible AND Vegetation is not suppressed
                                        if (!suppressVeg) {
                                            if (gVariant === 2) {
                                                // Wilderness Scrub
                                                const numScrubs = 3 + (seed % 3);
                                                const innerCx = (iT.x + iB.x) * 0.5;
                                                const innerCy = (iT.y + iB.y) * 0.5 - gardenZ;
                                                for (let i = 0; i < numScrubs; i++) {
                                                    const zoomScale = tileWidth / 60;
                                                    const jitterX = (((seed + i * 51) % 16) - 8) * zoomScale;
                                                    const jitterY = (((seed + i * 13) % 8) - 4) * zoomScale;
                                                    // FIX: Pass null/transparent stroke if showShadows is true
                                                    drawScrub(targetCtx, innerCx + jitterX, innerCy + jitterY, showShadows, getShadowShift, shadowColor, gridPath, 0.7);
                                                }
                                            } else {
                                                // Park/Garden Bushes
                                                const numBushes = 2 + (seed % 3);
                                                const innerCx = (iT.x + iB.x) * 0.5;
                                                const innerCy = (iT.y + iB.y) * 0.5 - gardenZ;
                                                for (let i = 0; i < numBushes; i++) {
                                                    const zoomScale = tileWidth / 60;
                                                    const jitterX = (((seed + i * 23) % 16) - 8) * zoomScale;
                                                    const jitterY = (((seed + i * 47) % 8) - 4) * zoomScale;
                                                    // FIX: Pass null/transparent stroke
                                                    drawBush(targetCtx, innerCx + jitterX, innerCy + jitterY, showShadows, getShadowShift, shadowColor, gridPath, 0.6);
                                                }
                                            }
                                        }
                                    }

                                    // --- DRAW PATHS ---
                                    if (plot.paths) {
                                        // VISUAL RULE: Only show Paths if NO rule active OR buildingRoadConstraint active
                                        const rule = getEffectiveHighlightRule();
                                        if (!rule || rule === 'buildingRoadConstraint') {
                                            drawPaths(targetCtx, x, y, tileWidth, tileHeight, plot.paths, showShadows, getShadowShift, shadowColor);
                                        }
                                    }
                                    // --- SHADOW ---
                                    if (showShadows) {
                                        const s = getShadowShift(blockZ);
                                        targetCtx.save();
                                        targetCtx.clip(gridPath); // Clip to slab
                                        targetCtx.globalCompositeOperation = 'darken';
                                        targetCtx.fillStyle = shadowColor;
                                        targetCtx.strokeStyle = shadowNoStroke;
                                        targetCtx.beginPath();

                                        const sx = s.x; // Shift X
                                        const sy_ground = sx * 0.5; // Shift Y on ground (slope 0.5)

                                        // Project points (Roof projected to ground)
                                        const pL = { x: cL.x + sx, y: cL.y + sy_ground };
                                        const pB = { x: cB.x + sx, y: cB.y + sy_ground };
                                        const pR = { x: cR.x + sx, y: cR.y + sy_ground };
                                        const pT = { x: cT.x + sx, y: cT.y + sy_ground };

                                        // Draw Shadow Hull (Base -> Projection)
                                        // Order: BaseLeft -> BaseFront -> BaseRight -> ProjRight -> ProjBack -> ProjLeft -> Close
                                        targetCtx.moveTo(cL.x, cL.y);
                                        targetCtx.lineTo(cB.x, cB.y);
                                        targetCtx.lineTo(cR.x, cR.y);
                                        targetCtx.lineTo(pR.x, pR.y);
                                        targetCtx.lineTo(pT.x, pT.y);
                                        targetCtx.lineTo(pL.x, pL.y);
                                        targetCtx.closePath();
                                        targetCtx.fill();
                                        targetCtx.restore();
                                    }

                                    // --- DRAW WALLS (Fill Only) ---
                                    // Recalculate based on potentially darkened floorColor to match
                                    const wallDark = darkenColor(floorColor, 20);
                                    const wallMedium = darkenColor(floorColor, 10);

                                    if (isExposedR) {
                                        targetCtx.fillStyle = wallDark; // Dark side
                                        targetCtx.beginPath();
                                        targetCtx.moveTo(cR.x, cR.y - blockZ);
                                        targetCtx.lineTo(cB.x, cB.y - blockZ);
                                        targetCtx.lineTo(cB.x, cB.y);
                                        targetCtx.lineTo(cR.x, cR.y);
                                        targetCtx.closePath();
                                        targetCtx.fill();

                                        // Door on Right Face (facing X+)
                                        // VISUAL RULE: Only show Door geometry if NO rule active OR doorCreation active
                                        if ((!getEffectiveHighlightRule() || getEffectiveHighlightRule() === 'doorCreation') && hasDoor(dataGrid, x, y, 'right')) {
                                            const nx = x + 1, ny = y;
                                            const nPlot = (nx < numCols) ? dataGrid[ny][nx] : null;
                                            const nColor = (nPlot && nPlot.name !== 'EMPTY') ? (nPlot.color || plotTypes[nPlot.name].color) : '#A1887F';
                                            targetCtx.fillStyle = nColor || '#A1887F';
                                            // Calculate door geometry on skewed face
                                            // Base Line: cR to cB
                                            // MidpointBase: (cR + cB) / 2
                                            const midX = (cR.x + cB.x) / 2;
                                            const midY = (cR.y + cB.y) / 2;
                                            const doorH = blockZ * 0.22; // Reduced height
                                            const doorW_Ratio = 0.11; // Thinner doors
                                            const dx = (cR.x - cB.x) * doorW_Ratio;
                                            const dy = (cR.y - cB.y) * doorW_Ratio;

                                            targetCtx.beginPath();
                                            targetCtx.moveTo(midX - dx, midY - dy); // Base Left
                                            targetCtx.lineTo(midX + dx, midY + dy); // Base Right
                                            targetCtx.lineTo(midX + dx, midY + dy - doorH); // Top Right
                                            targetCtx.lineTo(midX - dx, midY - dy - doorH); // Top Left
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                        }
                                    }
                                    if (isExposedB) {
                                        targetCtx.fillStyle = wallMedium; // Medium side
                                        targetCtx.beginPath();
                                        targetCtx.moveTo(cB.x, cB.y - blockZ);
                                        targetCtx.lineTo(cL.x, cL.y - blockZ);
                                        targetCtx.lineTo(cL.x, cL.y);
                                        targetCtx.lineTo(cB.x, cB.y);
                                        targetCtx.closePath();
                                        targetCtx.fill();

                                        // Door on Bottom Face (facing Y+) (Left Screen)
                                        // VISUAL RULE: Only show Door geometry if NO rule active OR doorCreation active
                                        if ((!getEffectiveHighlightRule() || getEffectiveHighlightRule() === 'doorCreation') && hasDoor(dataGrid, x, y, 'bottom')) {
                                            const nx = x, ny = y + 1;
                                            const nPlot = (ny < numRows) ? dataGrid[ny][nx] : null;
                                            const nColor = (nPlot && nPlot.name !== 'EMPTY') ? (nPlot.color || plotTypes[nPlot.name].color) : '#A1887F';
                                            targetCtx.fillStyle = nColor || '#A1887F';
                                            // Base Line: cB to cL
                                            const midX = (cB.x + cL.x) / 2;
                                            const midY = (cB.y + cL.y) / 2;
                                            const doorH = blockZ * 0.22;
                                            const doorW_Ratio = 0.11; // Thinner doors
                                            const dx = (cB.x - cL.x) * doorW_Ratio;
                                            const dy = (cB.y - cL.y) * doorW_Ratio;

                                            targetCtx.beginPath();
                                            targetCtx.moveTo(midX - dx, midY - dy);
                                            targetCtx.lineTo(midX + dx, midY + dy);
                                            targetCtx.lineTo(midX + dx, midY + dy - doorH);
                                            targetCtx.lineTo(midX - dx, midY - dy - doorH);
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                        }
                                    }

                                    // --- DRAW EDGES & OUTLINES ---
                                    // --- DRAW EDGES & OUTLINES ---

                                    // SHARED DEFINITIONS (Hoisted for use in both Shadow and Outline modes)
                                    const strokeColor = 'rgba(0,0,0,0.8)';
                                    const seamColor = darkenColor(lightGrey, 5); // Internal Seam
                                    const scaleFactor = tileHeight / 30;
                                    const thin = 0.5 * scaleFactor;
                                    const thick = 2.0 * scaleFactor; // Thicker for clearer diagram outlines

                                    targetCtx.lineCap = 'round';
                                    targetCtx.lineJoin = 'round';

                                    // Helpers for Neighbor Type Checking (Global)
                                    const isExisting = (nx, ny) => {
                                        if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) return false;
                                        const p = dataGrid[ny][nx];
                                        const z = zoneGrid[ny][nx];
                                        return p.name === 'EXISTING' || (z && z.name === 'EXISTING_HOUSING');
                                    };
                                    const sameL = isExisting(x - 1, y);
                                    const sameR = isExisting(x + 1, y);
                                    const sameT = isExisting(x, y - 1);
                                    const sameB = isExisting(x, y + 1);

                                    const drawLine = (p1, p2, isThick, color = strokeColor) => {
                                        targetCtx.lineWidth = isThick ? thick : thin;
                                        targetCtx.strokeStyle = color;
                                        targetCtx.beginPath(); targetCtx.moveTo(p1.x, p1.y); targetCtx.lineTo(p2.x, p2.y); targetCtx.stroke();
                                    };

                                    if (showShadows) {
                                        // SHADOW MODE SEAM FIX
                                        // Draw 'Plug' lines to fill gaps between tiles using wall colors.

                                        // cB (Front Center)
                                        if (isExposedR && !isExposedB) {
                                            // Hidden Face B, Exposed Face R -> Seam is on Face R side -> wallDark
                                            drawLine({ x: cB.x, y: cB.y }, { x: cB.x, y: cB.y - blockZ }, false, wallDark);
                                        } else if (!isExposedR && isExposedB) {
                                            // Hidden Face R, Exposed Face B -> Seam is on Face B side -> wallMedium
                                            drawLine({ x: cB.x, y: cB.y }, { x: cB.x, y: cB.y - blockZ }, false, wallMedium);
                                        }

                                        // cR (Right Edge) - Connects to Top Neighbor
                                        // If Face R is visible and we have a Top Neighbor, plug the gap.
                                        if (isExposedR && sameT) {
                                            drawLine({ x: cR.x, y: cR.y }, { x: cR.x, y: cR.y - blockZ }, false, wallDark);
                                        }

                                        // cL (Left Edge) - Connects to Left Neighbor
                                        // If Face B is visible and we have a Left Neighbor, plug the gap.
                                        if (isExposedB && sameL) {
                                            drawLine({ x: cL.x, y: cL.y }, { x: cL.x, y: cL.y - blockZ }, false, wallMedium);
                                        }
                                    }

                                    if (!showShadows) {
                                        // Merged Outlines
                                        // Definitions hoisted above...

                                        // 1. SEAM LINES (If face hidden)
                                        // If face is NOT exposed, we might still see the edge if the neighbor is physically lower or transparent?
                                        // But typically !isExposed means "Hidden by same group".
                                        // We keep existing seam logic but force Thin.
                                        if (!isExposedR) drawLine({ x: cR.x, y: cR.y - blockZ }, { x: cB.x, y: cB.y - blockZ }, false, seamColor);
                                        if (!isExposedB) drawLine({ x: cB.x, y: cB.y - blockZ }, { x: cL.x, y: cL.y - blockZ }, false, seamColor);

                                        // 2. FACE EDGES (If Exposed)

                                        // Front Roof Edges (R, B).
                                        // Always THIN (Internal Folds).
                                        if (isExposedR) drawLine({ x: cR.x, y: cR.y - blockZ }, { x: cB.x, y: cB.y - blockZ }, false);
                                        if (isExposedB) drawLine({ x: cB.x, y: cB.y - blockZ }, { x: cL.x, y: cL.y - blockZ }, false);

                                        // Back Roof Edges (L, T).
                                        // Silhouette if neighbor is NOT Existing.
                                        if (isExposedL) drawLine({ x: cL.x, y: cL.y - blockZ }, { x: cT.x, y: cT.y - blockZ }, !sameL);
                                        if (isExposedT) drawLine({ x: cT.x, y: cT.y - blockZ }, { x: cR.x, y: cR.y - blockZ }, !sameT);

                                        // Base Edges (R, B).
                                        // Silhouette if neighbor is NOT Existing.
                                        if (isExposedR) drawLine({ x: cR.x, y: cR.y }, { x: cB.x, y: cB.y }, !sameR);
                                        if (isExposedB) drawLine({ x: cB.x, y: cB.y }, { x: cL.x, y: cL.y }, !sameB);

                                        // Verticals

                                        // cB (Front Center).
                                        // If Corner (R & B exposed): Black Stroke.
                                        // If Flat R (R exposed, B hidden): "Plug" with Dark Wall Color.
                                        // If Flat B (B exposed, R hidden): "Plug" with Medium Wall Color.
                                        if (isExposedR && isExposedB) {
                                            drawLine({ x: cB.x, y: cB.y }, { x: cB.x, y: cB.y - blockZ }, false);
                                        } else if (isExposedR) {
                                            drawLine({ x: cB.x, y: cB.y }, { x: cB.x, y: cB.y - blockZ }, false, wallDark);
                                        } else if (isExposedB) {
                                            drawLine({ x: cB.x, y: cB.y }, { x: cB.x, y: cB.y - blockZ }, false, wallMedium);
                                        }

                                        // cR (Right Corner). Junction of Face R and Face T.
                                        if (isExposedR) {
                                            if (!sameT) {
                                                // True Corner
                                                drawLine({ x: cR.x, y: cR.y }, { x: cR.x, y: cR.y - blockZ }, !sameR);
                                            } else {
                                                // Seam with Top Neighbor (Face R continues) -> Plug with Dark Wall Color
                                                drawLine({ x: cR.x, y: cR.y }, { x: cR.x, y: cR.y - blockZ }, false, wallDark);
                                            }
                                        }

                                        // cL (Left Corner). Junction of Face B and Face L.
                                        if (isExposedB) {
                                            if (!sameL) {
                                                // True Corner
                                                drawLine({ x: cL.x, y: cL.y }, { x: cL.x, y: cL.y - blockZ }, !sameB);
                                            } else {
                                                // Seam with Left Neighbor (Face B continues) -> Plug with Medium Wall Color
                                                drawLine({ x: cL.x, y: cL.y }, { x: cL.x, y: cL.y - blockZ }, false, wallMedium);
                                            }
                                        }

                                        // Reset
                                        targetCtx.lineWidth = 1;
                                        targetCtx.lineJoin = 'miter'; // Reset lineJoin
                                        targetCtx.lineCap = 'butt'; // Reset lineCap
                                    }
                                }
                            }
                        }); // Close draw function, object, and push
                    }

                    // WORKSHOPS (Individual) AND FARMING SHEDS
                    if (showObjects && plot.name === 'FARMING' && plot.mergedWith) {
                        // Skip if rule is active and plot is not highlighted
                        const isHigh = plot._cachedHighlight;
                        const rule = getEffectiveHighlightRule();

                        // BUFFER SUPPRESSION: Hide Greenhouses in buffer zones
                        // (isBufferSuppressed helper is available in this scope now)
                        if (isBufferSuppressed()) {
                            continue;
                        }

                        // GREEN ZONE COMPLIANCE SUPPRESSION
                        if (rule === 'greenZoneCompliance') continue;

                        // STRICT WHITELIST: Only show Merged Farming if rule is 'farmingNeighbor'
                        if (rule && rule !== 'farmingNeighbor') {
                            continue;
                        }

                        if (plot.isMergeMaster) {
                            const myD = x + y;
                            const parD = plot.mergedWith.x + plot.mergedWith.y;
                            const minD = Math.min(myD, parD);
                            const maxD = Math.max(myD, parD);

                            // Calculate Color with Decay - Blue glass tint
                            let ghColor = '#A3D5E8'; // Light blue glass tint
                            if ((plot.decayStage || 0) > 0) ghColor = darkenColor(ghColor, 35);

                            // 1. Shadow Back
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: minD + 0.1,
                                type: 'GREENHOUSE_SHADOW_BACK',
                                draw: () => drawGreenhouse(
                                    targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                    renderShadows, 'SHADOW', 'BACK',
                                    tileWidth, tileHeight, gridPath, getShadowShift,
                                    shadowColor, shadowNoStroke, isoToScreen, hexToRgba, ghColor
                                )
                            });
                            // 2. Shadow Front
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: maxD + 0.05, // Adjusted depth
                                type: 'GREENHOUSE_SHADOW_FRONT',
                                draw: () => drawGreenhouse(
                                    targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                    renderShadows, 'SHADOW', 'FRONT',
                                    tileWidth, tileHeight, gridPath, getShadowShift,
                                    shadowColor, shadowNoStroke, isoToScreen, hexToRgba, ghColor
                                )
                            });

                            // 3. Building Back
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: minD + 0.4, // Adjusted depth: Lowered to sit behind front hedges (+0.45)
                                type: 'GREENHOUSE_BACK',
                                draw: () => {
                                    drawGreenhouse(
                                        targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                        renderShadows, 'BUILDING', 'BACK',
                                        tileWidth, tileHeight, gridPath, getShadowShift,
                                        shadowColor, shadowNoStroke, isoToScreen, hexToRgba, ghColor
                                    );
                                }
                            });

                            // 4. Building Front
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: maxD + 0.4, // Adjusted depth
                                type: 'GREENHOUSE_FRONT',
                                draw: () => {
                                    drawGreenhouse(
                                        targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                        renderShadows, 'BUILDING', 'FRONT',
                                        tileWidth, tileHeight, gridPath, getShadowShift,
                                        shadowColor, shadowNoStroke, isoToScreen, hexToRgba, ghColor
                                    );
                                }
                            });
                        }
                    } else if (showObjects && plot.name === 'WORKSHOP' && plot.mergedWith) {
                        // Skip if rule is active and plot is not highlighted
                        const rule = getEffectiveHighlightRule();

                        // VISUAL RULE: Suppress Trees in Recreational Buffer (sportDistance)
                        // Also suppress in Green Zone Compliance if requested (implied cleanup)
                        if (rule === 'sportDistance') return; // Skip drawing tree

                        // Existing Logic...
                        const isHigh = isHighlighted(x, y, plot, zone);

                        // STRICT WHITELIST: Only show Merged Workshop if rule is 'workshopRoadBonus' or 'workshopDistance'
                        const isWorkshopRule = (getEffectiveHighlightRule() === 'workshopRoadBonus' || getEffectiveHighlightRule() === 'workshopDistance');
                        if (getEffectiveHighlightRule() && !isWorkshopRule) {
                            continue;
                        }

                        if (plot.isMergeMaster) {
                            const myD = x + y;
                            const parD = plot.mergedWith.x + plot.mergedWith.y;
                            const minD = Math.min(myD, parD);
                            const maxD = Math.max(myD, parD);

                            // Calculate Highlight Color (Pass 2)
                            let drawColor = plot.color;
                            if (getEffectiveHighlightRule()) {
                                if (isHigh) {
                                    drawColor = lightenColor(drawColor, 30);
                                } else {
                                    drawColor = darkenColor(drawColor, 50);
                                }
                            }
                            // Decay Logic
                            if ((plot.decayStage || 0) > 0) drawColor = darkenColor(drawColor, 35);

                            // 1. Shadow Back
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: minD + 0.05, // Adjusted depth
                                type: 'WORKSHOP_SHADOW_BACK',
                                draw: () => drawWorkshop(
                                    targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                    renderShadows, 'SHADOW', 'BACK',
                                    tileWidth, tileHeight, gridPath, getShadowShift,
                                    shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor,
                                    drawColor, dataGrid, numCols, numRows, isInteracting, (simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN'), 'MERGED', 0, drawTree
                                )
                            });
                            // 2. Shadow Front
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: maxD + 0.05, // Adjusted depth
                                type: 'WORKSHOP_SHADOW_FRONT',
                                draw: () => drawWorkshop(
                                    targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                    renderShadows, 'SHADOW', 'FRONT',
                                    tileWidth, tileHeight, gridPath, getShadowShift,
                                    shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor,
                                    drawColor, dataGrid, numCols, numRows, isInteracting, (simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN'), 'MERGED', 0, drawTree
                                )
                            });

                            // 3. Building Back
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: minD + 0.4, // Adjusted depth
                                type: 'WORKSHOP_BACK',
                                draw: () => {
                                    drawWorkshop(
                                        targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                        renderShadows, 'BUILDING', 'BACK',
                                        tileWidth, tileHeight, gridPath, getShadowShift,
                                        shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor,
                                        drawColor, dataGrid, numCols, numRows, isInteracting, (simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN'), 'MERGED', 0, drawTree
                                    );
                                }
                            });

                            // 4. Building Front
                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: maxD + 0.4, // Adjusted depth
                                type: 'WORKSHOP_FRONT',
                                draw: () => {
                                    drawWorkshop(
                                        targetCtx, x, y, plot.mergedWith.x, plot.mergedWith.y,
                                        renderShadows, 'BUILDING', 'FRONT',
                                        tileWidth, tileHeight, gridPath, getShadowShift,
                                        shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor,
                                        drawColor, dataGrid, numCols, numRows, isInteracting, (simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN'), 'MERGED', 0, drawTree
                                    );
                                }
                            });
                        }
                    } else if (showObjects && plot.name === 'WORKSHOP') {
                        // Single Workshop Logic (Pass 2)
                        const isHigh = plot._cachedHighlight;
                        const rule = getEffectiveHighlightRule();

                        // Buffer Rule Logic
                        if ((rule === 'workshopDistance' || rule === 'sportDistance') && isHigh && plot.name !== 'EXISTING') {
                            if (rule === 'workshopDistance' && plot.name === 'WORKSHOP') { /* Allow */ }
                            else if (rule === 'sportDistance' && plot.name === 'SPORT') { /* Allow */ }
                            else { continue; }
                        }

                        renderList.push({
                            isHighlighted: isHigh,
                            isDying: (plot.decayStage || 0) > 0,
                            depth: depth + 0.4,
                            type: 'WORKSHOP',
                            draw: () => {
                                const layout = workshopLayouts.get(`${x},${y}`);
                                const wVariant = layout ? layout.variant : 0;
                                const wRotation = layout ? layout.rotation : 0;
                                let drawColor = plot.color;
                                if (getEffectiveHighlightRule() && isHigh) drawColor = lightenColor(drawColor, 30);
                                if ((plot.decayStage || 0) > 0) drawColor = darkenColor(drawColor, 35);

                                drawWorkshop(
                                    targetCtx, x, y, x, y, // Partner is self
                                    renderShadows, 'BUILDING', 'ALL',
                                    tileWidth, tileHeight, gridPath, getShadowShift,
                                    shadowColor, shadowNoStroke, isoToScreen, lightenColor, darkenColor,
                                    drawColor, dataGrid, numCols, numRows, isInteracting,
                                    (simulationRules.greenZoneCompliance && zoneGrid[y][x].name === 'GREEN'),
                                    wVariant, wRotation, drawTree
                                );
                            }
                        });
                    } else if (showObjects && plot.name === 'FARMING') {
                        // Skip if rule is active and plot is not highlighted
                        const isHigh = plot._cachedHighlight;
                        const rule = getEffectiveHighlightRule();

                        // REMOVED: if (getEffectiveHighlightRule() && !isHigh) continue; 
                        // We WANT to draw non-highlighted items (context), just faded.

                        // GREEN ZONE COMPLIANCE SUPPRESSION
                        if (rule === 'greenZoneCompliance') continue;

                        // Buffer Rule Suppression: Hide building if in buffer zone (only show Amber ground)
                        // BUT ALLOW the Rule-Target (Workshop/Sport) to show!
                        if ((rule === 'workshopDistance' || rule === 'sportDistance') && isHigh && plot.name !== 'EXISTING') {
                            // If this is the active rule's main type, allow it.
                            if (rule === 'workshopDistance' && plot.name === 'WORKSHOP') { /* Allow */ }
                            else if (rule === 'sportDistance' && plot.name === 'SPORT') { /* Allow */ }
                            else {
                                continue; // Suppress (It's a buffer zone object)
                            }
                        }
                        // Also suppress farming plots if sportDistance is active, regardless of highlight
                        if (rule === 'sportDistance') {
                            continue;
                        }

                        // Pre-pass for WORKSHOP/FARMING quadrant calculation
                        // This logic is moved to a pre-pass loop that runs before the main render loop.
                        // The result (plot.occupiedQuad) is stored directly on the plot object.


                        // Calculate Depth Offset for accurate sorting of sub-tile objects
                        // Quad 0 (Top) -> Behind (+0.35)
                        // Quad 1/3 (Middle) -> Mid (+1.0)
                        // Quad 2 (Bottom) -> Front (+1.65)
                        let depthOffset = 0;
                        if (plot.occupiedQuad === 0) depthOffset = 0.35;
                        else if (plot.occupiedQuad === 1 || plot.occupiedQuad === 3) depthOffset = 1.0;
                        else if (plot.occupiedQuad === 2) depthOffset = 1.65;

                        renderList.push({
                            isHighlighted: isHigh,
                            depth: depth + depthOffset,
                            type: 'WORKSHOP',
                            draw: () => {
                                // Read Pre-Calculated Quadrant
                                let quadrant = plot.occupiedQuad;
                                if (quadrant !== undefined && quadrant !== -1) {

                                    const bWidth = tileWidth * 0.33;  // 3x3 grid (1/3 plot)
                                    const bHeight = tileHeight * 0.33;

                                    // Randomize Height (Seed consistent per plot)
                                    // User Request: "Half length... 2.5, 3, 3.5" (Approx 0.25, 0.3, 0.35 of tileHeight)
                                    // Previous was 0.6 (approx 6m).
                                    const hSeed = (x * 492 + y * 821); // Simple seed
                                    const hVariant = Math.abs(hSeed) % 3;
                                    let heightFactor = 0.3; // Default 3m
                                    if (hVariant === 1) heightFactor = 0.25; // 2.5m
                                    else if (hVariant === 2) heightFactor = 0.35; // 3.5m

                                    const blockZ = tileHeight * heightFactor;

                                    // Adjusted offsets for 1/3 sized buildings to sit at edges
                                    let offsetX = 0, offsetY = 0;
                                    if (quadrant === 0) { offsetX = 0; offsetY = -tileHeight / 3; }
                                    if (quadrant === 1) { offsetX = tileWidth / 3; offsetY = 0; }
                                    if (quadrant === 2) { offsetX = 0; offsetY = tileHeight / 3; }
                                    if (quadrant === 3) { offsetX = -tileWidth / 3; offsetY = 0; }



                                    const startX = screenPos.x + offsetX;
                                    const startY = screenPos.y + tileHeight / 2 + offsetY - (bHeight / 2);

                                    const top = { x: startX, y: startY - blockZ };
                                    const right = { x: startX + bWidth / 2, y: startY + bHeight / 2 - blockZ };
                                    const bottom = { x: startX, y: startY + bHeight - blockZ };
                                    const left = { x: startX - bWidth / 2, y: startY + bHeight / 2 - blockZ };

                                    // --- SHADOW ---
                                    if (renderShadows) {
                                        const s = getShadowShift(blockZ);
                                        targetCtx.save();
                                        try {
                                            targetCtx.clip(gridPath);

                                            targetCtx.fillStyle = shadowColor;
                                            targetCtx.beginPath();

                                            const sx = s.x;
                                            const sy = s.y;

                                            // Projected Top Points
                                            const pL = { x: left.x + sx, y: left.y + sy };
                                            const pR = { x: right.x + sx, y: right.y + sy };
                                            const pB = { x: bottom.x + sx, y: bottom.y + sy };
                                            const pT = { x: top.x + sx, y: top.y + sy };

                                            // Base Points
                                            const bL = { x: left.x, y: left.y + blockZ };
                                            const bR = { x: right.x, y: right.y + blockZ };
                                            const bB = { x: bottom.x, y: bottom.y + blockZ };

                                            // Shadow Hull: BaseLeft -> BaseFront -> BaseRight -> ProjRight -> ProjBack -> ProjLeft
                                            targetCtx.moveTo(bL.x, bL.y);
                                            targetCtx.lineTo(bR.x, bR.y);
                                            targetCtx.lineTo(pR.x, pR.y);
                                            targetCtx.lineTo(pB.x, pB.y);
                                            targetCtx.lineTo(pL.x, pL.y);
                                            targetCtx.lineTo(pT.x, pT.y);
                                            targetCtx.closePath();
                                            targetCtx.fill();
                                        } finally {
                                            targetCtx.restore();
                                        }
                                    }

                                    // 1. Draw TOP Face
                                    targetCtx.fillStyle = lightenColor(plot.color, 30);
                                    targetCtx.beginPath(); targetCtx.moveTo(top.x, top.y); targetCtx.lineTo(right.x, right.y); targetCtx.lineTo(bottom.x, bottom.y); targetCtx.lineTo(left.x, left.y); targetCtx.closePath(); targetCtx.fill();

                                    // 2. Draw LEFT Face
                                    targetCtx.fillStyle = darkenColor(plot.color, 15);
                                    targetCtx.beginPath(); targetCtx.moveTo(left.x, left.y); targetCtx.lineTo(bottom.x, bottom.y); targetCtx.lineTo(bottom.x, bottom.y + blockZ); targetCtx.lineTo(left.x, left.y + blockZ); targetCtx.closePath(); targetCtx.fill();

                                    // 3. Draw RIGHT Face
                                    targetCtx.fillStyle = darkenColor(plot.color, 25);
                                    targetCtx.beginPath(); targetCtx.moveTo(bottom.x, bottom.y); targetCtx.lineTo(right.x, right.y); targetCtx.lineTo(right.x, right.y + blockZ); targetCtx.lineTo(bottom.x, bottom.y + blockZ); targetCtx.closePath(); targetCtx.fill();

                                    // 4. Draw OUTLINES (Overlay)
                                    if (!showShadows && !isInteracting) {
                                        const strokeColor = 'rgba(0,0,0,0.8)';
                                        const dividerColor = 'rgba(0,0,0,0.4)'; // Increased visibility
                                        // Scale Outlines
                                        const scaleFactor = tileHeight / 30;
                                        const thinWidth = 0.5 * scaleFactor;
                                        const thickWidth = 1.0 * scaleFactor; // 2x Inner
                                        targetCtx.lineCap = 'round';
                                        targetCtx.lineJoin = 'round';

                                        // Neighbor Checks
                                        const getQuad = (nx, ny) => {
                                            if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) return -1;
                                            return dataGrid[ny][nx].occupiedQuad;
                                        };
                                        const q = quadrant;

                                        // Robust Adjacency: Check if "My Side" faces "Neighbor's Corresponding Side"
                                        const checkAdj = (nx, ny, validQuads) => {
                                            const nq = getQuad(nx, ny);
                                            return validQuads.includes(nq);
                                        };

                                        // Right Neighbor (Checking Boundary X+1)
                                        // My Front-Right Face (Q1, Q2) touches Neighbor's Left Side (Q0, Q3) OR Merged (4)
                                        const nRight = (q === 1 || q === 2) && checkAdj(x + 1, y, [0, 3, 4]);

                                        // Left Neighbor (Checking Boundary X-1)
                                        // My Back-Left Face (Q0, Q3) touches Neighbor's Right Side (Q1, Q2) OR Merged (4)
                                        const nLeft = (q === 0 || q === 3) && checkAdj(x - 1, y, [1, 2, 4]);

                                        // Bottom Neighbor (Checking Boundary Y+1)
                                        // My Front-Left Face (Q2, Q3) touches Neighbor's Top Side (Q0, Q1) OR Merged (4)
                                        const nBottom = (q === 2 || q === 3) && checkAdj(x, y + 1, [0, 1, 4]);

                                        // Top Neighbor (Checking Boundary Y-1)
                                        // My Back-Right Face (Q0, Q1) touches Neighbor's Bottom Side (Q2, Q3) OR Merged (4)
                                        const nTop = (q === 0 || q === 1) && checkAdj(x, y - 1, [2, 3, 4]);

                                        const line = (p1, p2, isThick) => {
                                            targetCtx.lineWidth = isThick ? thickWidth : thinWidth;
                                            targetCtx.strokeStyle = isThick ? strokeColor : dividerColor;
                                            targetCtx.beginPath(); targetCtx.moveTo(p1.x, p1.y); targetCtx.lineTo(p2.x, p2.y); targetCtx.stroke();
                                        };

                                        // A. INNER FOLDS (Always Thin)
                                        // Front Roof Edges
                                        line(bottom, right, false);
                                        line(bottom, left, false);
                                        // Front Vertical (at bottom)
                                        line(bottom, { x: bottom.x, y: bottom.y + blockZ }, false);

                                        // B. SILHOUETTE (Conditional Thick)

                                        // Back Roof Edges
                                        // Top-Right Edge (Back-Right): Depends on nTop.
                                        line(top, right, !nTop);
                                        // Top-Left Edge (Back-Left): Depends on nLeft.
                                        line(top, left, !nLeft);

                                        // Side Verticals & Base
                                        const bRight = { x: right.x, y: right.y + blockZ };
                                        const bBottom = { x: bottom.x, y: bottom.y + blockZ };
                                        const bLeft = { x: left.x, y: left.y + blockZ };

                                        // Right Side (Faces: Front-Right nRight, Back-Right nTop)
                                        // Vertical: Thick if both neighboring faces are missing
                                        line(right, bRight, !(nRight || nTop));
                                        // Base: Thick if Front-Right neighbor missing
                                        line(bBottom, bRight, !nRight);

                                        // Left Side (Faces: Front-Left nBottom, Back-Left nLeft)
                                        // Vertical: Thick if both neighboring faces are missing
                                        line(left, bLeft, !(nLeft || nBottom));
                                        // Base: Thick if Front-Left neighbor missing
                                        line(bBottom, bLeft, !nBottom);

                                        targetCtx.lineWidth = 1;
                                    }

                                    if (!showShadows && !isInteracting) {
                                        targetCtx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
                                        targetCtx.lineWidth = 0.75 * (tileHeight / 30);
                                        targetCtx.stroke();
                                    }
                                } // End if (quadrant)
                            } // End draw
                        }); // End push
                    } else if (showObjects && plot.name === 'SPORT') {
                        const rule = getEffectiveHighlightRule();
                        // GREEN ZONE COMPLIANCE SUPPRESSION (Sport Objects)
                        if (rule === 'greenZoneCompliance') continue;

                        // Buffer Rule Suppression: Hide sport items if in buffer zone
                        // BUT ALLOW Sport items if it is a Sport Rule!
                        if ((rule === 'workshopDistance' || rule === 'sportDistance') && isHighlighted(x, y, plot, zone)) {
                            // If I am a SPORT plot and rule is SPORT, allow.
                            if (rule === 'sportDistance' && plot.name === 'SPORT') { /* Allow */ }
                            else {
                                continue; // Suppress
                            }
                        }

                        // SPORT ITEMS
                        // Use Computed Layout
                        const layout = sportLayouts.get(`${x},${y}`);
                        const variant = layout ? layout.variant : 0;
                        const rotation = layout ? layout.rotation : 0;

                        renderList.push({
                            isHighlighted: isHighlighted(x, y, plot, zone),
                            isDying: (plot.decayStage || 0) > 0,
                            depth: (variant === 3) ? depth + 1.5 : depth + 0.1, // Tennis Net pops (1.5), others sit lower (0.1) to avoid popping over hedges
                            type: 'SPORT_ITEM',
                            draw: () => {
                                drawSportObject(
                                    targetCtx, screenPos.x, screenPos.y,
                                    tileWidth, tileHeight,
                                    variant, rotation, // Uses layout.rotation
                                    renderShadows, getShadowShift, shadowColor,
                                    gridPath, // gridPath for clipping
                                    plot.isMergeMaster, // NEW Argument
                                    squish
                                );
                            }
                        });
                    }

                    // TREES
                    // VEGETATION (Trees, Bushes, Scrub)
                    if (showObjects && (plot.treeCount > 0 || plot.name === 'GREEN')) {
                        const rule = getEffectiveHighlightRule();
                        // Skip if rule is active and plot is not highlighted
                        const isHigh = plot._cachedHighlight || false; // Use cached value
                        // REMOVED: if (getEffectiveHighlightRule() && !isHigh) continue;

                        // GREEN ZONE COMPLIANCE SUPPRESSION (Hide vegetation to show zone clearly)
                        if (rule === 'greenZoneCompliance') continue;

                        // Buffer Rule Suppression: Hide vegetation if in buffer zone
                        // Vegetation is usually generic, so we suppress it in ALL buffer zones, UNLESS it's on the target plot?
                        // Actually, trees on updates Workshop/Sport plots might be desirable, but let's stick to the rule: "Hide objects in buffer".
                        // If the plot is WORKSHOP/SPORT, we might want to keep its trees if it has any.
                        if ((rule === 'workshopDistance' || rule === 'sportDistance') && isHigh && plot.name !== 'EXISTING') {
                            if (rule === 'workshopDistance' && plot.name === 'WORKSHOP') { /* Allow */ }
                            else if (rule === 'sportDistance' && plot.name === 'SPORT') { /* Allow */ }
                            else {
                                continue;
                            }
                        }
                        // Also suppress all vegetation if sportDistance is active, regardless of highlight
                        if (rule === 'sportDistance') {
                            continue;
                        }


                        let variant = (plot.variant !== undefined) ? plot.variant : 0;
                        if (plot.name !== 'GREEN') variant = 0; // Force Park style for non-Green plots

                        const fillOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8];
                        let seed = x * 71523 + y * 92719; // Unique seed per plot
                        const seededRandom = () => {
                            const x = Math.sin(seed++) * 10000;
                            return x - Math.floor(x);
                        };

                        // Shuffle for Park (0) and Wilderness (2), but Keep Order for Garden (1)
                        if (variant !== 1) {
                            for (let i = fillOrder.length - 1; i > 0; i--) {
                                const j = Math.floor(seededRandom() * (i + 1));
                                [fillOrder[i], fillOrder[j]] = [fillOrder[j], fillOrder[i]];
                            }
                        }

                        let itemsToDraw = plot.treeCount;
                        if (plot.name === 'GREEN' && itemsToDraw < 1) itemsToDraw = 1; // Always show at least 1 tree on Green plots

                        if (plot.name === 'GREEN') {
                            // Base items per variant, plus donated trees
                            const donatedExtra = Math.max(0, (plot.treeCount || 0) - 1);
                            if (variant === 0) itemsToDraw = Math.min(9, 1 + donatedExtra); // Park: 1 base + donated
                            else if (variant === 1) itemsToDraw = Math.min(9, 4 + donatedExtra); // Garden: 4 base + donated
                            else if (variant === 2) itemsToDraw = Math.min(9, 6 + donatedExtra); // Wilderness: 6 base + donated
                        }

                        // Use plot rotation if available, otherwise use deterministic random based on position (Lazy Init Visualization)
                        const rot = (plot.rotation !== undefined) ? plot.rotation : ((x * 7 + y * 13) % 4);

                        // Sport Masking: Use PRE-CALCULATED rotation from sportLayouts
                        let sportRotForMask = 0;
                        if (plot.name === 'SPORT') {
                            const layout = sportLayouts.get(`${x},${y}`);
                            if (layout) sportRotForMask = layout.rotation;
                        }

                        let drawnCount = 0;
                        for (let i = 0; i < 9; i++) {
                            if (drawnCount >= itemsToDraw) break;
                            const posIndex = fillOrder[i];



                            // 1. Logical Position (Layout Space)
                            const lRow = Math.floor(posIndex / 3);
                            const lCol = posIndex % 3;

                            // 2. Center-Relative Coordinates (Layout Space)
                            const lSubX = lCol - 1;
                            const lSubY = lRow - 1;

                            // 3. Apply Rotation (0, 90, 180, 270 deg clockwise)
                            let rx = lSubX;
                            let ry = lSubY;
                            const turns = rot % 4;
                            for (let t = 0; t < turns; t++) {
                                const tmp = rx;
                                rx = -ry;
                                ry = tmp;
                            }

                            // 4. Calculate Final Screen Offset
                            const offsetX = rx * (tileWidth / 6) + ry * (-tileWidth / 6);
                            const offsetY = rx * (tileHeight / 6) + ry * (tileHeight / 6);

                            // 5. Rotated Grid Coordinates (for Depth & Farming)
                            const col = rx + 1;
                            const row = ry + 1;

                            // POST-ROTATION PATH MASKING
                            // Mask based on ROTATED 'col' and 'row' (0..2)
                            if (plot.paths) {
                                if (plot.paths.right) { // World Right (X+1) Edge -> Mask Col 2
                                    if (col === 2) continue;
                                }
                                if (plot.paths.bottom) { // World Bottom (Y+1) Edge -> Mask Row 2
                                    if (row === 2) continue;
                                }
                            }
                            // Mask incoming neighbor paths
                            if (y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom) { // Top Edge (Y-1 Bottom) -> Mask Row 0
                                if (row === 0) continue;
                            }
                            if (x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right) { // Left Edge (X-1 Right) -> Mask Col 0
                                if (col === 0) continue;
                            }

                            // START GARDEN QUARTERS LOGIC
                            if (variant === 1) {
                                // Paved (Right Edge: 5, 8) -> Moved to Pass 1 for Shadow Occlusion
                                if (posIndex === 5 || posIndex === 8) {
                                    drawnCount++;
                                    continue;
                                }
                                // Grass (Bottom Center: 6, 7) + Buffer Center (4) - Skip
                                if (posIndex === 6 || posIndex === 7 || posIndex === 4) {
                                    drawnCount++;
                                    continue;
                                }
                            }

                            if ((plot.name === 'WORKSHOP' || plot.name === 'FARMING')) {
                                if (plot.mergedWith) continue;
                                if (plot.occupiedQuad !== undefined) {
                                    let q = plot.occupiedQuad;
                                    if (q === 0 && [0, 1, 2, 4].includes(posIndex)) continue;
                                    if (q === 1 && [2, 5, 8, 4].includes(posIndex)) continue;
                                    if (q === 2 && [6, 7, 8, 4].includes(posIndex)) continue;
                                    if (q === 3 && [0, 3, 6, 4].includes(posIndex)) continue;
                                }

                                // WORKSHOP COLLISION (Garage/Actual/Social)
                                if (plot.name === 'WORKSHOP') {
                                    const wLayout = workshopLayouts.get(`${x},${y}`);
                                    if (wLayout) {
                                        const wVar = wLayout.variant;
                                        const wRot = wLayout.rotation; // 0, 1, 2, 3

                                        // Helper: Rotate a 3x3 grid index (0-8) by 90 degrees clockwise 'times' times
                                        const rotateIndex = (idx, times) => {
                                            for (let t = 0; t < times; t++) {
                                                const row = Math.floor(idx / 3);
                                                const col = idx % 3;
                                                // New Col = Old Row
                                                // New Row = 2 - Old Col
                                                // But indices are:
                                                // 0 1 2
                                                // 3 4 5
                                                // 6 7 8
                                                // Rotated 90 CW:
                                                // 6 3 0
                                                // 7 4 1
                                                // 8 5 2
                                                const newRow = col;
                                                const newCol = 2 - row;
                                                idx = newRow * 3 + newCol;
                                            }
                                            return idx;
                                        };

                                        // Define Base Exclusion Masks (Unrotated - generally facing Bottom/South)
                                        let excludedBase = [];

                                        if (wVar === 1) {
                                            // Variant 1: "Big Workshop" (Social) - 0.6x0.6 Box at Top-Left (approx)
                                            // Occupies Top-Left 2x2 area roughly
                                            excludedBase = [0, 1, 3, 4];
                                        } else if (wVar === 0) {
                                            // Variant 0: Garage - Central Vertical Axis
                                            excludedBase = [1, 4, 7];
                                        } else if (wVar === 2) {
                                            // Variant 2: Actual - Shed (Top Center) + Stacks (Bottom Center)
                                            // Occupies mainly the central vertical column + maybe slight spread
                                            // Let's be safer and exclude a "Cross" to avoid clipping
                                            excludedBase = [1, 3, 4, 5, 7];
                                        }

                                        // Apply Rotation to the Mask?
                                        // The posIndex is the tree position.
                                        // The building rotates.
                                        // So we must rotate the EXCLUSION ZONES to match the building.
                                        // But wait, the standard "Base" definition above assumes Rotation 0.
                                        // If Rotation is 1 (90 CW), the building moves.
                                        // Example: Garage (1,4,7) rotated 90 -> (3,4,5).

                                        const finalExcluded = excludedBase.map(i => rotateIndex(i, wRot));

                                        if (finalExcluded.includes(posIndex)) continue;
                                    }
                                }
                            }

                            if (plot.name === 'EXISTING' && mergedCellsMap.has(`${x},${y}`)) continue;

                            if (plot.name === 'FARMING') {
                                const layout = getFarmingLayout(x, y);
                                if (layout.split === 'X') {
                                    if (layout.brownFirst && col <= 1) continue;
                                    if (!layout.brownFirst && col >= 1) continue;
                                } else {
                                    if (layout.brownFirst && row <= 1) continue;
                                    if (!layout.brownFirst && row >= 1) continue;
                                }
                            }

                            // SPORT MASKING CHECK
                            if (plot.name === 'SPORT') {
                                // Use the forced rotation!
                                const sRot = sportRotForMask;
                                let allowedIndices = [];
                                if (sRot === 0) allowedIndices = [0, 2];
                                else if (sRot === 1) allowedIndices = [2, 8];
                                else if (sRot === 2) allowedIndices = [6, 8];
                                else if (sRot === 3) allowedIndices = [0, 6];

                                if (!allowedIndices.includes(posIndex)) continue;
                            }

                            const localDepth = (col + row) / 6;
                            const treeDepth = depth + localDepth;

                            const heightSeed = (x * 37 + y * 13 + posIndex * 7) % 3;
                            let heightScale = 1.0;
                            if (heightSeed === 0) heightScale = 0.8;
                            else if (heightSeed === 1) heightScale = 1.0;
                            else heightScale = 1.2;

                            renderList.push({
                                isHighlighted: isHigh,
                                isDying: (plot.decayStage || 0) > 0,
                                depth: treeDepth,
                                type: 'VEGETATION',
                                draw: () => {
                                    // Calculate Tree Base Position
                                    const treeX = screenPos.x + offsetX;
                                    const treeY = screenPos.y + tileHeight / 2 + offsetY;

                                    // Shadow Check
                                    let inShadow = false;
                                    if (showShadows) {
                                        for (const poly of shadowPolygons) {
                                            if (pointInPolygon(treeX, treeY, poly)) {
                                                inShadow = true;
                                                break;
                                            }
                                        }
                                    }

                                    if (variant === 1) {
                                        // Garden: Draw Bushes + 1 Mandatory Tree
                                        if (i === 0) {
                                            drawTree(targetCtx, treeX, treeY, renderShadows, getShadowShift, shadowColor, gridPath, 0.9, inShadow, (plot.decayStage || 0) > 0);
                                        } else {
                                            drawBush(targetCtx, treeX, treeY, renderShadows, getShadowShift, shadowColor, gridPath, 0.9, inShadow, (plot.decayStage || 0) > 0);
                                        }
                                    } else if (variant === 2) {
                                        // Wilderness: Guaranteed Trees + Scrub
                                        const isForcesTree = (i < 3); // Since it's shuffled, this just ensures 3 trees exist
                                        if (isForcesTree) {
                                            drawTree(targetCtx, treeX, treeY, renderShadows, getShadowShift, shadowColor, gridPath, heightScale * 0.9, inShadow, (plot.decayStage || 0) > 0);
                                        } else {
                                            // Varied Scrub
                                            const scrubSize = (heightSeed === 0) ? 1.4 : 1.0; // Mix sizes
                                            drawScrub(targetCtx, treeX, treeY, renderShadows, getShadowShift, shadowColor, gridPath, scrubSize, inShadow, (plot.decayStage || 0) > 0);
                                        }
                                    } else {
                                        // Park (Default)
                                        drawTree(targetCtx, treeX, treeY, renderShadows, getShadowShift, shadowColor, gridPath, heightScale, inShadow, (plot.decayStage || 0) > 0);
                                    }
                                }
                            });

                            drawnCount++;
                        }


                    }

                }
            }
        }
        // RENDER LIST EXECUTION (Pass 2)
        renderList.sort((a, b) => a.depth - b.depth);
        // renderList.forEach(item => item.draw()); // REMOVED Redundant Loop



        // 3. Sort and Execute Render List
        // Reset Context State to prevent bleeding from Pass 1 (e.g. Thick Black Lines from Existing Housing)
        targetCtx.strokeStyle = gridStrokeColor;
        targetCtx.lineWidth = 0.5;

        for (const item of renderList) {
            if (getEffectiveHighlightRule()) {
                if (item.isHighlighted) {
                    targetCtx.globalAlpha = 1.0;
                } else {
                    targetCtx.globalAlpha = 0.2;
                }
            } else if (item.isDying) {
                // targetCtx.globalAlpha = 0.2; // REMOVED Transparency
                // Rely on pre-darkened colors in render objects OR apply filter here?
                // For Merged objects, color is pre-calculated. For others, we might need a generic darken?
                // Actually, merged objects calculate 'drawColor' when pushing to list. I need to update THAT logic.
                // But simplified: just apply a composite operation? No, that's expensive.
                // Let's assume colors are darkened in the 'draw' closures.
                targetCtx.globalAlpha = 1.0;
            } else {
                targetCtx.globalAlpha = 1.0;
            }
            if (item.draw) item.draw();
            targetCtx.globalAlpha = 1.0;
        }

        // PASS 3: DRAW SCORES ON TOP OF EVERYTHING (if enabled)
        if (!isEditMode && showScores) {
            for (let y = 0; y < numRows; y++) {
                for (let x = 0; x < numCols; x++) {
                    const plot = dataGrid[y][x];
                    const zone = zoneGrid[y][x];
                    if (plot.value > 0 && zone.name !== 'SKELETON' && zone.name !== 'AQUEDUCT') {
                        const screenPos = isoToScreen(x, y);
                        targetCtx.fillStyle = '#000';
                        targetCtx.font = `bold ${tileHeight / 3}px monospace`;
                        targetCtx.textAlign = 'center';
                        targetCtx.textBaseline = 'middle';
                        const textY = screenPos.y + tileHeight / 2;
                        targetCtx.fillText(plot.value.toFixed(2), screenPos.x, textY);
                    }
                }
            }
        }

    }

    // OPTIMIZATION: Dynamic Overlay Draw
    function drawDynamicOverlays(targetCtx, options = {}) {
        // --- INSPECTOR SELECTION OUTLINE ---
        if (activeInspectorPlot) {
            const ix = activeInspectorPlot.x;
            const iy = activeInspectorPlot.y;
            // Check boundaries
            if (ix >= 0 && ix < numCols && iy >= 0 && iy < numRows) {
                const screenPos = isoToScreen(ix, iy);
                targetCtx.save();
                targetCtx.strokeStyle = 'white';
                targetCtx.lineWidth = 1.5;
                targetCtx.lineJoin = 'round';
                targetCtx.lineCap = 'round';
                targetCtx.beginPath();
                targetCtx.moveTo(screenPos.x, screenPos.y);
                targetCtx.lineTo(screenPos.x + tileWidth / 2, screenPos.y + tileHeight / 2);
                targetCtx.lineTo(screenPos.x, screenPos.y + tileHeight);
                targetCtx.lineTo(screenPos.x - tileWidth / 2, screenPos.y + tileHeight / 2);
                targetCtx.closePath();
                targetCtx.stroke();
                targetCtx.restore();
            }
        }
        // --- PATH HOVER FEEDBACK ---
        if (hoveredCell && hoveredCell.edge && currentBrush && currentBrush.name === 'PATH') {
            targetCtx.save(); // SAVE STATE
            const hx = hoveredCell.x;
            const hy = hoveredCell.y;
            const screenPos = isoToScreen(hx, hy);
            targetCtx.fillStyle = '#FF5722';
            targetCtx.globalAlpha = 0.8;
            targetCtx.beginPath();

            const getS = (u, v) => ({
                x: screenPos.x + u * (tileWidth / 2) + v * (-tileWidth / 2),
                y: screenPos.y + u * (tileHeight / 2) + v * (tileHeight / 2)
            });
            const edgeMargin = 0.13;

            if (hoveredCell.edge === 'right') {
                const c1 = getS(1 - edgeMargin, 0), c2 = getS(1 + edgeMargin, 0), c3 = getS(1 + edgeMargin, 1), c4 = getS(1 - edgeMargin, 1);
                targetCtx.moveTo(c1.x, c1.y); targetCtx.lineTo(c2.x, c2.y); targetCtx.lineTo(c3.x, c3.y); targetCtx.lineTo(c4.x, c4.y);
            } else if (hoveredCell.edge === 'bottom') {
                const c1 = getS(0, 1 - edgeMargin), c2 = getS(1, 1 - edgeMargin), c3 = getS(1, 1 + edgeMargin), c4 = getS(0, 1 + edgeMargin);
                targetCtx.moveTo(c1.x, c1.y); targetCtx.lineTo(c2.x, c2.y); targetCtx.lineTo(c3.x, c3.y); targetCtx.lineTo(c4.x, c4.y);
            } else if (hoveredCell.edge === 'left') {
                const c1 = getS(-edgeMargin, 0), c2 = getS(edgeMargin, 0), c3 = getS(edgeMargin, 1), c4 = getS(-edgeMargin, 1);
                targetCtx.moveTo(c1.x, c1.y); targetCtx.lineTo(c2.x, c2.y); targetCtx.lineTo(c3.x, c3.y); targetCtx.lineTo(c4.x, c4.y);
            } else if (hoveredCell.edge === 'top') {
                const c1 = getS(0, -edgeMargin), c2 = getS(1, -edgeMargin), c3 = getS(1, edgeMargin), c4 = getS(0, edgeMargin);
                targetCtx.moveTo(c1.x, c1.y); targetCtx.lineTo(c2.x, c2.y); targetCtx.lineTo(c3.x, c3.y); targetCtx.lineTo(c4.x, c4.y);
            }
            targetCtx.fill();
            targetCtx.restore(); // RESTORE STATE
        }

        // --- HOVER OUTLINE ---
        if (hoveredCell && !viewState.isDragging) {
            const hx = hoveredCell.x;
            const hy = hoveredCell.y;
            if (hx >= 0 && hx < numCols && hy >= 0 && hy < numRows) {
                const screenPos = isoToScreen(hx, hy);
                const hPlot = dataGrid[hy][hx];
                targetCtx.save();
                targetCtx.strokeStyle = 'black';
                const isOccupied = hPlot.name !== 'EMPTY';
                targetCtx.lineWidth = isOccupied ? 3 : 1;
                targetCtx.lineJoin = 'round';
                targetCtx.lineCap = 'round';
                targetCtx.beginPath();
                targetCtx.moveTo(screenPos.x, screenPos.y);
                targetCtx.lineTo(screenPos.x + tileWidth / 2, screenPos.y + tileHeight / 2);
                targetCtx.lineTo(screenPos.x, screenPos.y + tileHeight);
                targetCtx.lineTo(screenPos.x - tileWidth / 2, screenPos.y + tileHeight / 2);
                targetCtx.closePath();
                targetCtx.stroke();
                targetCtx.restore();
            }
        }
    }

    // MAIN RENDER ORCHESTRATOR
    // Stub for paintAt (missing function)
    // MAIN RENDER ORCHESTRATOR
    // Implemented paintAt
    function paintAt(gridX, gridY, isShift) {
        if (gridX < 0 || gridX >= numCols || gridY < 0 || gridY >= numRows) return;

        const plot = dataGrid[gridY][gridX];
        const zone = zoneGrid[gridY][gridX];

        // 1. ERASE MODE (also: Erase toggle with a zone brush)
        const isZoneBrush = currentBrush && currentBrush.name !== 'PATH' && currentBrush.name !== 'BOARD_EDITOR';
        if (currentMode === 'erase' || (eraseToolActive && isZoneBrush)) {
            if (plot.name === 'REMOVED') return; // removed plots are only restored with the Board Editor
            invalidateStaticCache();
            // Release a merge partner that points back at this plot
            if (plot.mergedWith) {
                const pr = dataGrid[plot.mergedWith.y] && dataGrid[plot.mergedWith.y][plot.mergedWith.x];
                if (pr && pr.mergedWith && pr.mergedWith.x === gridX && pr.mergedWith.y === gridY) {
                    pr.mergedWith = null;
                    updateTile(plot.mergedWith.x, plot.mergedWith.y);
                }
            }
            // Fresh empty plot (also clears paths, merges and farming layout)
            dataGrid[gridY][gridX] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
            // Reset zone to NEUTRAL and clear plot
            zoneGrid[gridY][gridX] = zoneTypes.NEUTRAL;

            updateTile(gridX, gridY, isShift); // Helper to redraw/update
            // Update neighbors for path connections
            updateTile(gridX + 1, gridY);
            updateTile(gridX - 1, gridY);
            updateTile(gridX, gridY + 1);
            updateTile(gridX, gridY - 1);
            return;
        }

        if (!currentBrush) return;

        // 2. BOARD_EDITOR
        if (currentBrush.name === 'BOARD_EDITOR') {
            if (isShift) {
                // Remove the plot
                plot.name = 'REMOVED';
                plot.paths = null;
                plot.mergedWith = null;
                plot.farmingLayout = null;
                plot.value = 0;
                zoneGrid[gridY][gridX] = zoneTypes.NONE;
            } else {
                // Add the plot back if it was removed (or just reset it to EMPTY)
                if (plot.name === 'REMOVED') {
                    plot.name = 'EMPTY';
                    plot.paths = null;
                    plot.mergedWith = null;
                    plot.farmingLayout = null;
                    plot.value = 0;
                    zoneGrid[gridY][gridX] = zoneTypes.NEUTRAL;
                }
            }
            updateTile(gridX, gridY, false);
            updateTile(gridX + 1, gridY);
            updateTile(gridX - 1, gridY);
            updateTile(gridX, gridY + 1);
            updateTile(gridX, gridY - 1);
            return;
        }

        // 3. PATH PAINTING
        if (currentBrush.name === 'PATH') {
            if (hoveredCell && hoveredCell.edge) {
                const edge = hoveredCell.edge;
                const plot = dataGrid[gridY][gridX];
                if (!plot.paths) plot.paths = {};

                // SHIFT + CLICK/DRAG -> REMOVE PATH
                if (isShift) {
                    let changed = false;
                    if (edge === 'right') {
                        if (plot.paths.right) {
                            plot.paths.right = false;
                            changed = true;
                            updateTile(gridX, gridY);
                            if (gridX + 1 < numCols) updateTile(gridX + 1, gridY);
                        }
                    }
                    else if (edge === 'bottom') {
                        if (plot.paths.bottom) {
                            plot.paths.bottom = false;
                            changed = true;
                            updateTile(gridX, gridY);
                            if (gridY + 1 < numRows) updateTile(gridX, gridY + 1);
                        }
                    }
                    else if (edge === 'left') {
                        if (gridX > 0) {
                            const n = dataGrid[gridY][gridX - 1];
                            if (n.paths && n.paths.right) {
                                n.paths.right = false;
                                changed = true;
                                updateTile(gridX - 1, gridY);
                                updateTile(gridX, gridY);
                            }
                        }
                    }
                    else if (edge === 'top') {
                        if (gridY > 0) {
                            const n = dataGrid[gridY - 1][gridX];
                            if (n.paths && n.paths.bottom) {
                                n.paths.bottom = false;
                                changed = true;
                                updateTile(gridX, gridY - 1);
                                updateTile(gridX, gridY);
                            }
                        }
                    }

                    if (changed) {
                        invalidateStaticCache();
                        // No drawScene() here, usually managed by loop or caller? 
                        // But paintAt is called in loop. 
                        // Actually, invalidating cache is key.
                    }
                    return;
                }

                // NORMAL PAINT -> ADD PATH
                if (edge === 'right') plot.paths.right = true;
                if (edge === 'bottom') plot.paths.bottom = true;
                if (edge === 'left') {
                    // Left interaction is tricky, typically we set the NEIGHBOR's right.
                    if (gridX > 0) {
                        const n = dataGrid[gridY][gridX - 1];
                        if (!n.paths) n.paths = {};
                        n.paths.right = true;
                        updateTile(gridX - 1, gridY);
                    }
                }
                if (edge === 'top') {
                    // Top interaction -> Neighbor's bottom
                    if (gridY > 0) {
                        const n = dataGrid[gridY - 1][gridX];
                        if (!n.paths) n.paths = {};
                        n.paths.bottom = true;
                        updateTile(gridX, gridY - 1);
                    }
                }
                updateTile(gridX, gridY);
            }
            return;
        }

        // 4. GENERIC BRUSHES (FARMING, WORKSHOP, SPORT, GREEN)
        // Only paint the ZONE - plots spawn during simulation via getDevelopmentChance()
        if (currentBrush.name) {
            if (zoneGrid[gridY][gridX] !== currentBrush) {
                const oldZone = zoneGrid[gridY][gridX];
                zoneGrid[gridY][gridX] = currentBrush;

                // Handle EXISTING_HOUSING zone changes
                if (oldZone.name === 'EXISTING_HOUSING' && currentBrush.name !== 'EXISTING_HOUSING') {
                    if (dataGrid[gridY][gridX].name === 'EXISTING') {
                        dataGrid[gridY][gridX] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
                    }
                } else if (oldZone.name !== 'EXISTING_HOUSING' && currentBrush.name === 'EXISTING_HOUSING') {
                    dataGrid[gridY][gridX] = { ...plotTypes.EXISTING, age: 0, treeCount: 0 };
                }

                // Painting AQUEDUCT or NONE should clear the plot
                if (currentBrush.name === 'AQUEDUCT' || currentBrush.name === 'NONE') {
                    dataGrid[gridY][gridX] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
                }

                invalidateStaticCache();
                updateTile(gridX, gridY);
            }
        }
    }

    function drawScene() { requestRender(); } // Redirect to new renderer
    function legacy_drawScene(targetCtx, options = {}) { // Canvas 2D renderer for export and pixel mode
        // --- PIXEL MODE LOGIC ---
        if (pixelMode && !options.isInternalPixelPass && !options.skipPixelMode) {
            const width = options.width || targetCtx.canvas.width;
            const height = options.height || targetCtx.canvas.height;
            if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;

            let factor = options.pixelFactor;
            if (!factor) {
                const validScale = Number.isFinite(viewState.zoom) && viewState.zoom > 0 ? viewState.zoom : 1;
                factor = Math.max(2, Math.floor(pixelFactor * 0.6 * Math.pow(validScale, pixelExponent)));
            }

            const scaledW = Math.max(1, Math.ceil(width / factor));
            const scaledH = Math.max(1, Math.ceil(height / factor));

            if (!persistentPixelCanvas) persistentPixelCanvas = document.createElement('canvas');
            const offCanvas = persistentPixelCanvas;

            if (offCanvas.width !== scaledW || offCanvas.height !== scaledH) {
                offCanvas.width = scaledW;
                offCanvas.height = scaledH;
            } else {
                const offCtxCheck = offCanvas.getContext('2d');
                offCtxCheck.setTransform(1, 0, 0, 1, 0, 0);
                offCtxCheck.clearRect(0, 0, offCanvas.width, offCanvas.height);
            }

            const offCtx = offCanvas.getContext('2d');
            offCtx.imageSmoothingEnabled = false;
            offCtx.scale(1 / factor, 1 / factor);

            // Recursion
            legacy_drawScene(offCtx, { ...options, width: width, height: height, isInternalPixelPass: true, pixelFactor: factor });

            if (typeof updateProgressBarFixed === 'function') updateProgressBarFixed();

            // Clear & Blit Scaled
            targetCtx.clearRect(0, 0, width, height);
            try {
                targetCtx.save();
                targetCtx.imageSmoothingEnabled = false;
                targetCtx.drawImage(offCanvas, 0, 0, scaledW, scaledH, 0, 0, width, height);
                targetCtx.restore();
            } catch (err) { console.warn("Pixel Mode drawImage failed:", err); }
            return;
        }

        // --- CACHING LOGIC ---
        // Use Logical Size if provided (e.g. for Pixel Mode or Export), otherwise physical canvas size
        const renderWidth = options.width || targetCtx.canvas.width;
        const renderHeight = options.height || targetCtx.canvas.height;

        // Determine if we need to update the static cache
        const isSizeMatch = staticCanvas.width === renderWidth && staticCanvas.height === renderHeight;
        const isTransparencyMatch = (staticCanvas._cachedTransparent === !!options.transparentBackground);

        if (isStaticDirty || !isSizeMatch || !isTransparencyMatch) {
            if (!isSizeMatch) {
                staticCanvas.width = renderWidth;
                staticCanvas.height = renderHeight;
            }
            // Call Static Draw
            drawStaticToCache(staticCtx, renderWidth, renderHeight, options);

            // Update Cache Metadata
            staticCanvas._cachedTransparent = !!options.transparentBackground;
            isStaticDirty = false;
        }

        // Blit Static Cache
        // Explicit Clean to prevent ghosting if alpha leaked or transparent background
        if (!options.isInternalPixelPass) {
            targetCtx.clearRect(0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
        }

        targetCtx.save();
        targetCtx.drawImage(staticCanvas, 0, 0);
        targetCtx.restore();

        // Draw Dynamic Overlays
        drawDynamicOverlays(targetCtx, options);
    }

    function getFarmingLayout(x, y) {
        // Use Persistent Layout if rotated to avoid paths
        if (dataGrid[y][x] && dataGrid[y][x].farmingLayout) return dataGrid[y][x].farmingLayout;

        // Smart Layout: Avoid placing Green Half (Buildings) adjacent to EXISTING buildings/housing
        // OR adjacent to ROADS if that rule is on.
        if (simulationRules.farmingNeighbor || simulationRules.buildingRoadConstraint) {
            let scoreXL = 0; // Preference for Green on Left (Brown on Right)
            let scoreXR = 0; // Preference for Green on Right (Brown on Left)
            let scoreYT = 0; // Preference for Green on Top (Brown on Bottom)
            let scoreYB = 0; // Preference for Green on Bottom (Brown on Top)

            const isExisting = (nx, ny) => {
                if (nx < 0 || nx >= numCols || ny < 0 || ny >= numRows) return false;
                const p = dataGrid[ny][nx];
                // Check for EXISTING or EXISTING_HOUSING
                return p.name === 'EXISTING' || p.name === 'EXISTING_HOUSING';
            };

            // Neighbor Constraints
            // 1. AVOID EXISTING HOUSING (Gray) - REPEL BUILDING (Buffer)
            // If Existing is on Right, we want Green on Right (Buffer).
            if (isExisting(x + 1, y)) scoreXR += 10;
            if (isExisting(x - 1, y)) scoreXL += 10;
            if (isExisting(x, y + 1)) scoreYB += 10;
            if (isExisting(x, y - 1)) scoreYT += 10;

            // 2. ATTRACT TO INDUSTRY (Workshops/Farming)
            const isIndustry = (nx, ny) => {
                if (nx < 0 || nx >= numCols || ny < 0 || ny >= numRows) return false;
                const p = dataGrid[ny][nx];
                return p.name === 'WORKSHOP' || p.name === 'FARMING';
            };

            // Preference (+15) to orient Green Side TOWARDS Industry? 
            // Original code: Industry Right -> scoreXR += 15 (Green Right).
            // This puts Green next to Industry. 
            // Usually we want Clusters of Buildings?
            // If Green is next to Industry, Buildings are separated by Green.
            // Let's keep original logic for now (Green matches Green?), or assume "Attract to Industry" means Building next to Building?
            // "Strong preference (+15) to orient Green Side TOWARDS Industry"
            // If I have Farming on Right, and I put Green on Right, I have Green-Farming.
            // If I put Brown on Right, I have Brown-Farming (Building next to Plot).
            // Assuming "Green Side Towards Industry" means Green buffer. 
            // I will leave this identical to original for now to avoid side effects, unless user implies ALL buildings should cluster.
            // User only mentioned Farming vs Existing/Path.
            if (isIndustry(x + 1, y)) scoreXR += 15;
            if (isIndustry(x - 1, y)) scoreXL += 15;
            if (isIndustry(x, y + 1)) scoreYB += 15;
            if (isIndustry(x, y - 1)) scoreYT += 15;

            // ROAD CONSTRAINTS (if Building Road Constraint is ON)
            // User Request: "force the buildings to still choose the path side"
            // So we want Building (Brown) next to Path.
            // Path Right -> Building Right -> Green Left (scoreXL).
            if (simulationRules.buildingRoadConstraint) {

                // Helper for Edges
                const hasPathRight = dataGrid[y][x].paths && dataGrid[y][x].paths.right;
                const hasPathBottom = dataGrid[y][x].paths && dataGrid[y][x].paths.bottom;
                const hasPathLeft = x > 0 && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right;
                const hasPathTop = y > 0 && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom;

                // SKELETON ROADS + PATHS
                // If Path is on Right, we want Building Right (Green Left -> scoreXL)
                if (checkIsRoad(x + 1, y) || hasPathRight) scoreXL += 20;
                if (checkIsRoad(x - 1, y) || hasPathLeft) scoreXR += 20;
                if (checkIsRoad(x, y + 1) || hasPathBottom) scoreYT += 20;
                if (checkIsRoad(x, y - 1) || hasPathTop) scoreYB += 20;
            }

            const max = Math.max(scoreXL, scoreXR, scoreYT, scoreYB);

            if (max > 0) {
                // Return best config
                if (scoreXL === max) return { split: 'X', brownFirst: false }; // Green Left (Brown Right)
                if (scoreXR === max) return { split: 'X', brownFirst: true };  // Green Right (Brown Left)
                if (scoreYT === max) return { split: 'Y', brownFirst: false }; // Green Top (Brown Bottom)
                if (scoreYB === max) return { split: 'Y', brownFirst: true };  // Green Bottom (Brown Top)
            }
        }

        // Fallback to Deterministic Random
        const val = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        // Split Type: 'X' (World Vertical) or 'Y' (World Horizontal)
        let split = val < 0.5 ? 'X' : 'Y';
        // Order: Brown First (Low Index) vs Green First (Low Index)
        let brownFirst = (val < 0.25 || (val >= 0.5 && val < 0.75));

        return { split, brownFirst };
    }




    function pointInPolygon(x, y, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function drawTree(ctx, x, y, showSha, getShift, sCol, gridPath, heightScale = 1.0, isInShadow = false, isDying = false) {
        try {
            // SCALING FIX: Dimensions now relative to tileHeight (Zoom Dependent)
            const scaleFactor = tileHeight / 30; // Normalize against base height
            const trunkW = 3 * scaleFactor * heightScale;
            const trunkH = 6 * scaleFactor * heightScale;
            const foliageRadius = 6 * scaleFactor * heightScale;

            if (showSha) {
                ctx.save();
                try {
                    ctx.clip(gridPath); // Optimize: Skip clipping for small shadows
                    ctx.fillStyle = sCol;
                    ctx.beginPath(); // Start Single Path for Merge

                    const totalH = trunkH + foliageRadius;
                    const s = getShift(totalH);
                    const shadowCx = x + s.x;
                    const shadowCy = y + s.y - totalH;

                    // Connection (Trunk Shadow)
                    const vx = shadowCx - x;
                    const vy = shadowCy - y;
                    const dist = Math.sqrt(vx * vx + vy * vy);

                    if (dist > 1) {
                        const angle = Math.atan2(vy, vx);
                        const shadowTrunkW = trunkW * 0.5; // Thinner shadow (was trunkW)
                        const halfW = shadowTrunkW / 2;
                        const dx = Math.cos(angle + Math.PI / 2) * halfW;
                        const dy = Math.sin(angle + Math.PI / 2) * halfW;

                        ctx.moveTo(x + dx, y + dy);
                        ctx.lineTo(x - dx, y - dy);
                        ctx.lineTo(shadowCx - dx, shadowCy - dy);
                        ctx.lineTo(shadowCx + dx, shadowCy + dy);
                        ctx.closePath();
                    }

                    // Draw Foliage Blob (New Subpath)
                    try {
                        // Move to start of ellipse to avoid connecting line from rect
                        ctx.moveTo(shadowCx + foliageRadius * 1.0, shadowCy);
                        ctx.ellipse(shadowCx, shadowCy, foliageRadius * 1.0, foliageRadius * 0.5, 0, 0, Math.PI * 2);
                    } catch (e) {
                        ctx.moveTo(shadowCx + foliageRadius * 0.8, shadowCy);
                        ctx.arc(shadowCx, shadowCy, foliageRadius * 0.8, 0, Math.PI * 2);
                    }
                    ctx.fill();
                } finally {
                    ctx.restore();
                }
            }

            // Apply Shadow Darkening if needed
            let trunkColor = '#8B7355';
            let foliageColor = '#7FCD91';
            let foliageLight = '#BAFCA2';

            if (isInShadow) {
                trunkColor = darkenColor(trunkColor, 30);
                foliageColor = darkenColor(foliageColor, 20);
                foliageLight = darkenColor(foliageLight, 20);
            }
            if (isDying) {
                trunkColor = darkenColor(trunkColor, 35);
                foliageColor = darkenColor(foliageColor, 35);
                foliageLight = darkenColor(foliageLight, 35);
            }

            ctx.fillStyle = trunkColor; ctx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
            if (!showSha && !isInteracting) {
                const isDark = document.body.classList.contains('dark-mode');
                ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                ctx.lineWidth = 0.7 * scaleFactor;
                ctx.strokeRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
            }
            ctx.beginPath(); ctx.arc(x, y - trunkH - foliageRadius + 2, foliageRadius, 0, Math.PI * 2);
            ctx.fillStyle = foliageColor; ctx.fill();
            if (!showSha && !isInteracting) {
                const isDark = document.body.classList.contains('dark-mode');
                ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                ctx.lineWidth = 0.7 * scaleFactor;
                ctx.stroke();
            }
            if (showSha) {
                ctx.beginPath(); ctx.arc(x - 2, y - trunkH - foliageRadius, foliageRadius / 2, 0, Math.PI * 2);
                ctx.fillStyle = foliageLight; ctx.fill();
            }

        } catch (err) {
            console.error("Error drawing tree:", err);
        }
    }

    function drawBush(ctx, x, y, showSha, getShift, sCol, gridPath, scale = 1.0, isInShadow = false, isDying = false) {
        try {
            const scaleFactor = tileHeight / 30;
            const radius = 4 * scaleFactor * scale;

            if (showSha) {
                ctx.save();
                try {
                    if (gridPath) ctx.clip(gridPath); // Optimize: Skip clipping for small shadows
                    ctx.fillStyle = sCol;
                    ctx.beginPath();
                    const s = getShift(radius * 0.5);
                    try {
                        ctx.ellipse(x + s.x, y + s.y, radius, radius * 0.5, 0, 0, Math.PI * 2);
                    } catch (e) {
                        ctx.arc(x + s.x, y + s.y, radius, 0, Math.PI * 2);
                    }
                    ctx.fill();
                } finally {
                    ctx.restore();
                }
            }

            // Bush Body
            let bodyColor = '#66BB6A';
            let highColor = '#A5D6A7';

            if (isInShadow) {
                bodyColor = darkenColor(bodyColor, 20);
                highColor = darkenColor(highColor, 20);
            }
            if (isDying) {
                bodyColor = darkenColor(bodyColor, 35);
                highColor = darkenColor(highColor, 35);
            }

            ctx.beginPath(); ctx.arc(x, y - radius * 0.5, radius, 0, Math.PI * 2);
            ctx.fillStyle = bodyColor; // Medium Green
            ctx.fill();
            if (!showSha && !isInteracting) {
                const isDark = document.body.classList.contains('dark-mode');
                ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                ctx.lineWidth = 0.7 * scaleFactor;
                ctx.stroke();
            }

            // Highlight
            if (showSha) {
                ctx.beginPath(); ctx.arc(x - radius * 0.3, y - radius * 0.5 - radius * 0.3, radius * 0.4, 0, Math.PI * 2);
                ctx.fillStyle = highColor; // Lighter Green
                ctx.fill();
            }
        } catch (err) { }
    }

    function drawScrub(ctx, x, y, showSha, getShift, sCol, gridPath, scale = 1.0, isInShadow = false, isDying = false) {
        try {
            const scaleFactor = tileHeight / 30;
            const r = 2.5 * scaleFactor * scale; // Reduced size

            if (showSha) {
                ctx.save();
                try {
                    if (gridPath) ctx.clip(gridPath); // Optimize: Skip clipping for small shadows
                    ctx.fillStyle = sCol;
                    ctx.beginPath();
                    const s = getShift(r * 0.5);
                    ctx.ellipse(x + s.x, y + s.y, r * 1.5, r * 0.5, 0, 0, Math.PI * 2);
                    ctx.fill();
                } finally {
                    ctx.restore();
                }
            }

            // Cluster of 3 small tufts
            let baseTuftColor = '#649938';
            let tuftColor = '#43A047';
            let tuftHigh = '#81C784';

            if (isInShadow) {
                baseTuftColor = darkenColor(baseTuftColor, 20);
                tuftColor = darkenColor(tuftColor, 20);
                tuftHigh = darkenColor(tuftHigh, 20);
            }
            if (isDying) {
                baseTuftColor = darkenColor(baseTuftColor, 35);
                tuftColor = darkenColor(tuftColor, 35);
                tuftHigh = darkenColor(tuftHigh, 35);
            }

            ctx.fillStyle = baseTuftColor; // Lighter/Warmer Wild Green (Olive)

            // Tufts - tighter to avoid popping out
            const offsets = [
                { x: -r * 0.6, y: 0, s: 1.0 },
                { x: r * 0.6, y: 0, s: 0.9 },
                { x: 0, y: -r * 0.7, s: 1.1 }
            ];

            offsets.forEach(o => {
                // Base
                ctx.fillStyle = tuftColor; // Fresh Forest Green
                ctx.beginPath();
                ctx.arc(x + o.x, y + o.y, r * o.s, 0, Math.PI * 2);
                ctx.fill();
                if (!showSha && !isInteracting) {
                    const isDark = document.body.classList.contains('dark-mode');
                    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
                    ctx.lineWidth = 0.7 * scaleFactor;
                    ctx.stroke();
                }

                // Highlight (Shading)
                if (showSha) {
                    ctx.fillStyle = tuftHigh; // Soft Green Highlight
                    ctx.beginPath();
                    ctx.arc(x + o.x - r * 0.2 * o.s, y + o.y - r * 0.2 * o.s, r * o.s * 0.6, 0, Math.PI * 2);
                    ctx.fill();
                }
            });

        } catch (err) { }
    }


    // TAB LOGIC
    const tabGrid = document.getElementById('tab-grid');
    const tabGraph = document.getElementById('tab-graph');
    const viewGrid = document.getElementById('grid-view');
    const viewGraph = document.getElementById('graph-view');

    function switchTab(tab) {
        // 1. Capture State & Pause for Performance
        const wasRunning = (typeof simulationInterval !== 'undefined' && simulationInterval !== null);
        if (wasRunning) pauseSimulation();

        activeTab = tab;
        const resetBtn = document.getElementById('resetViewBtn'); // Local scope ref
        const canvasControls = document.getElementById('canvasControls');
        const container = viewGrid.parentElement; // Used for transition class

        // CLEAR INLINE STYLES to allow CSS transition to work
        viewGrid.style.display = '';
        viewGraph.style.display = '';

        // UPDATE SLIDING INDICATOR
        const activeBtn = tab === 'grid' ? tabGrid : tabGraph;
        if (activeBtn) {
            const indicator = document.querySelector('.tab-indicator');
            if (indicator) {
                indicator.style.width = `${activeBtn.offsetWidth}px`;
                indicator.style.left = `${activeBtn.offsetLeft}px`;
            }
        }

        if (tab === 'grid') {
            tabGrid.classList.add('active');
            tabGraph.classList.remove('active');

            // TRANSITION STATE: Remove class to show Grid (0,0) and hide Graph (-100%)
            if (container) container.classList.remove('view-analytics');

            // RESET ANALYSIS STATS to ensure smooth resumption of animations
            if (typeof statDisplays !== 'undefined') {
                for (let key in statDisplays) {
                    const el = statDisplays[key];
                    if (el) delete el.dataset.animFrame;
                }
            }

            if (resetBtn) resetBtn.style.display = '';
            if (canvasControls) canvasControls.style.display = '';
            const blueprintToolbar = document.getElementById('blueprint-toolbar');
            if (blueprintToolbar) blueprintToolbar.style.display = '';

            drawScene();
        } else {
            tabGrid.classList.remove('active');
            tabGraph.classList.add('active');

            // TRANSITION STATE: Add class to Move World Down (+100%) and Sky Down (0%)
            if (container) container.classList.add('view-analytics');

            // RESET STATS FOR RE-ANIMATION
            // We set them to default values so animateValue() sees a change and animates up/down
            const statsToReset = [
                'stat-trees', 'stat-paved', 'stat-green', 'stat-age',
                'stat-merged-workshop', 'stat-merged-farming', 'stat-merged-sport',
                'stat-diversity', 'stat-doors', 'stat-total-planted', 'stat-participating'
            ];
            statsToReset.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.textContent = '0'; // Reset to 0 to force animation from start
                    delete el.dataset.animFrame; // Clear any conflicting animation state
                    delete el.dataset.lastTarget; // Clear custom tracking
                }
            });

            // --- RESET BTN & TOOLBAR VISIBILITY NOW HANDLED BY CSS TRANSITION ON .view-analytics CLASS ---

            drawGraph();
            // Always show the live participating plots count, even without simulation
            updateParticipatingPlotsDisplay();
        }

        // 2. Resume after Transition (0.8s + buffer = 850ms)
        if (wasRunning) {
            setTimeout(() => {
                startSimulation();
            }, 850);
        }
    }

    if (tabGrid && tabGraph) {
        tabGrid.addEventListener('click', () => switchTab('grid'));
        tabGraph.addEventListener('click', () => switchTab('graph'));

        // INITIALIZE INDICATOR
        setTimeout(() => {
            const indicator = document.querySelector('.tab-indicator');
            if (indicator && tabGrid) {
                indicator.style.width = `${tabGrid.offsetWidth}px`;
                indicator.style.left = `${tabGrid.offsetLeft}px`;
            }
        }, 100); // Small delay to ensure layout is computed
    }

    let graphHoverX = null;
    const graphCanvas = document.getElementById('graphCanvas');
    if (graphCanvas) {
        graphCanvas.addEventListener('mousemove', (e) => {
            const rect = graphCanvas.getBoundingClientRect();
            graphHoverX = e.clientX - rect.left;
            drawGraph(); // Redraw to update hover line
        });
        graphCanvas.addEventListener('mouseleave', () => {
            graphHoverX = null;
            document.getElementById('floating-tooltip').classList.remove('visible'); // Use class instead of inline style
            // document.getElementById('floating-tooltip').style.display = 'none'; // REMOVED to avoid blocking Grid tooltips
            drawGraph();
        });
    }



    function setupParameterControls() {
        for (const key in sliders) {
            if (sliders[key]) {
                let value = simulationParameters[key];

                // Special handling for tickSpeed (Inverted mapping)
                // Special handling for tickSpeed (Discrete Steps)
                if (key === 'tickSpeed') {
                    // Steps: 0.10x (10000ms) to Max (100ms)
                    // Map Value 0-9 to Index
                    const steps = [
                        { ms: 10000, label: "0.10x" },
                        { ms: 4000, label: "0.25x" },
                        { ms: 2000, label: "0.50x" },
                        { ms: 1333, label: "0.75x" },
                        { ms: 1000, label: "1.00x" },
                        { ms: 800, label: "1.25x" },
                        { ms: 666, label: "1.50x" },
                        { ms: 500, label: "2.00x" },
                        { ms: 250, label: "4.00x" },
                        { ms: 100, label: "MAX" }
                    ];
                    // Find closest step to initial value
                    let closestIdx = 4; // Default 1x
                    let minDiff = Infinity;
                    const currentMs = simulationParameters[key];
                    for (let i = 0; i < steps.length; i++) {
                        const diff = Math.abs(steps[i].ms - currentMs);
                        if (diff < minDiff) {
                            minDiff = diff;
                            closestIdx = i;
                        }
                    }
                    value = closestIdx;
                }
                else if (key !== 'reEvaluationAge' && key !== 'farmingMergeAge' && !key.startsWith('baseScore')) value = Math.round(value * 100);

                sliders[key].value = value;

                if (sliderValues[`${key}Value`]) {
                    if (key === 'tickSpeed') {
                        const steps = [
                            { ms: 10000, label: "0.10x" },
                            { ms: 4000, label: "0.25x" },
                            { ms: 2000, label: "0.50x" },
                            { ms: 1333, label: "0.75x" },
                            { ms: 1000, label: "1.00x" },
                            { ms: 800, label: "1.25x" },
                            { ms: 666, label: "1.50x" },
                            { ms: 500, label: "2.00x" },
                            { ms: 250, label: "4.00x" },
                            { ms: 100, label: "MAX" }
                        ];
                        // Value here is the INDEX we just calculated above
                        sliderValues[`${key}Value`].textContent = steps[value] ? steps[value].label : "1.00x";
                    }
                    else if (key === 'farmingMergeChance' || key === 'workshopMergeChance' || key === 'doorChance' || key === 'toppingChance' ||
                        key === 'greenSpawnRate' || key === 'farmingSpawnRate' || key === 'sportSpawnRate' || key === 'workshopSpawnRate') {
                        sliderValues[`${key}Value`].textContent = (simulationParameters[key] * 100).toFixed(0) + "%";
                    } else {
                        sliderValues[`${key}Value`].textContent = simulationParameters[key].toFixed((key === 'reEvaluationAge' || key === 'farmingMergeAge') ? 0 : (key.startsWith('baseScore') ? 1 : 2));
                    }
                }

                sliders[key].addEventListener('input', (event) => {
                    const slider = event.target;
                    const valueSpan = sliderValues[`${key}Value`];
                    let sliderVal = parseFloat(slider.value);

                    if (key === 'tickSpeed') {
                        const steps = [
                            { ms: 10000, label: "0.10x" },
                            { ms: 4000, label: "0.25x" },
                            { ms: 2000, label: "0.50x" },
                            { ms: 1333, label: "0.75x" },
                            { ms: 1000, label: "1.00x" },
                            { ms: 800, label: "1.25x" },
                            { ms: 666, label: "1.50x" },
                            { ms: 500, label: "2.00x" },
                            { ms: 250, label: "4.00x" },
                            { ms: 100, label: "MAX" }
                        ];
                        // Clamp index
                        const idx = Math.min(steps.length - 1, Math.max(0, parseInt(sliderVal)));
                        simulationParameters[key] = steps[idx].ms;

                        // FIX: Update label with proper TEXT, not %
                        if (valueSpan) valueSpan.textContent = steps[idx].label;

                        // Restart Loop safely
                        if (simulationInterval) {
                            pauseSimulation();
                            startSimulation();
                        } else {
                            // If it wasn't running, we just leave it paused (new speed applies on next start)
                        }
                    }
                    else if (key !== 'reEvaluationAge' && key !== 'farmingMergeAge' && !key.startsWith('baseScore')) {
                        simulationParameters[key] = sliderVal / 100;
                    } else {
                        simulationParameters[key] = sliderVal;
                    }

                    // Remove Separate Restart Block (integrated above)

                    if (valueSpan && key !== 'tickSpeed') {
                        if (key === 'farmingMergeChance' || key === 'workshopMergeChance' || key === 'doorChance' || key === 'toppingChance' ||
                            key === 'greenSpawnRate' || key === 'farmingSpawnRate' || key === 'sportSpawnRate' || key === 'workshopSpawnRate') {
                            valueSpan.textContent = (simulationParameters[key] * 100).toFixed(0) + "%";
                        } else {
                            valueSpan.textContent = simulationParameters[key].toFixed((key === 'reEvaluationAge' || key === 'farmingMergeAge') ? 0 : (key.startsWith('baseScore') ? 1 : 2));
                        }
                    }
                });
            }
        }
    }



    if (modeBtn) {
        modeBtn.addEventListener('click', () => {
            if (currentMode === 'draw') {
                currentMode = 'simulate';
                modeBtn.textContent = 'STOP & EDIT ZONES';
                // Deactivate freeze tool when entering simulation mode
                freezeToolActive = false;
                dragRectStart = null;
                dragRectEnd = null;
                startBtn.disabled = false; pauseBtn.disabled = false; canvas.style.cursor = 'default';
                startSimulation();
            } else {
                currentMode = 'draw';
                modeBtn.textContent = 'START SIMULATION';
                startBtn.disabled = true; pauseBtn.disabled = true; canvas.style.cursor = 'crosshair';
                pauseSimulation();
            }
            invalidateStaticCache(); // Ensure immediate visual update
            drawScene();
        });
        modeBtn.addEventListener('mouseenter', () => updateInfoBox(modeBtn.dataset.info));
        modeBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }
    startBtn.addEventListener('click', startSimulation);
    startBtn.addEventListener('mouseenter', () => updateInfoBox(startBtn.dataset.info));
    startBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    pauseBtn.addEventListener('click', pauseSimulation);
    pauseBtn.addEventListener('mouseenter', () => updateInfoBox(pauseBtn.dataset.info));
    pauseBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    resetBtn.addEventListener('click', () => {
        if (EXPO_MODE) { resetGrid(true); return; }
        if (activeTab !== 'grid') switchTab('grid');
        pauseSimulation();
        initialize();
    });

    // EXHIBITION: load the example layout from expo_layout.js (only when the grid size matches)
    function applyExpoLayout() {
        const data = window.EXPO_START_LAYOUT;
        if (data && data.numRows === numRows && data.numCols === numCols) applyZoneLayout(data);
    }

    // EXHIBITION: Reset (⟳) goes back to the example layout, Clear (✕) empties the grid. Both return to draw mode.
    function resetGrid(withExample) {
        if (activeTab !== 'grid') switchTab('grid');
        pauseSimulation();
        currentMode = 'draw';
        isPainting = false;
        selectedPlot = null;
        hideInspector();
        initialize();
        if (withExample) applyExpoLayout();
        const statusEl = document.getElementById('sim-status-text');
        if (statusEl) statusEl.textContent = 'READY ⏹';
    }

    if (EXPO_MODE) {
        resetBtn.dataset.info = 'Back to the example layout.';
        resetBtn.title = 'Reset to example';
        const clearBtn = document.createElement('button');
        clearBtn.id = 'clear-sim';
        clearBtn.className = 'btn-icon blueprint-cell';
        clearBtn.title = 'Clear';
        clearBtn.dataset.info = 'Clear the grid to draw your own layout.';
        clearBtn.textContent = '✕';
        resetBtn.after(clearBtn);
        clearBtn.addEventListener('click', () => resetGrid(false));
        clearBtn.addEventListener('mouseenter', () => updateInfoBox(clearBtn.dataset.info));
        clearBtn.addEventListener('mouseleave', () => updateInfoBox(""));
    }
    resetBtn.addEventListener('mouseenter', () => updateInfoBox(resetBtn.dataset.info));
    resetBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    // Rule Toggles
    const ruleCheckboxes = {
        ruleWorkshopRoad: 'workshopRoadBonus',
        ruleWorkshopDistance: 'workshopDistance',
        ruleBuildingRoadConstraint: 'buildingRoadConstraint',
        ruleSportDistance: 'sportDistance',
        ruleFarmingNeighbor: 'farmingNeighbor',
        ruleAqueductGreen: 'aqueductGreenOnly',
        ruleTreeDonation: 'treeDonation',
        ruleDoorCreation: 'doorCreation',
        ruleTopping: 'toppingRule',
        ruleGreenZoneCompliance: 'greenZoneCompliance',
        ruleMerging: 'allowMerging',
        ruleGreenLung: 'greenLung'
    };

    for (const [id, ruleKey] of Object.entries(ruleCheckboxes)) {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                simulationRules[ruleKey] = e.target.checked;

                // FORCE RECALCULATION OF TREES
                // This ensures visual feedback is immediate even if simulation is paused
                if (ruleKey === 'treeDonation' || ruleKey === 'toppingRule') {
                    for (let y = 0; y < numRows; y++) {
                        for (let x = 0; x < numCols; x++) {
                            // Reset tree count to baseline 0 before recalculating
                            // Note: We don't reset age/merged status, just trees
                            if (dataGrid[y][x]) dataGrid[y][x].treeCount = 0;
                        }
                    }
                    calculateTrees();
                }

                // FORCE RECALCULATION OF BUILDING POSITIONS (Quadrants)
                // This ensures buildings shift to/from road-side or existing neighbors when rule is toggled
                if (ruleKey === 'buildingRoadConstraint' || ruleKey === 'farmingNeighbor') {
                    calculateQuadrants(dataGrid);
                }

                invalidateStaticCache();
                drawScene(); // Redraw in case visual rules changed
            });
            // Use data-info from parent label
            checkbox.parentElement.addEventListener('mouseenter', () => {
                updateInfoBox(checkbox.parentElement.dataset.info);
                activeHighlightRule = ruleKey;
                invalidateStaticCache();
                drawScene();
            });
            checkbox.parentElement.addEventListener('mouseleave', () => {
                updateInfoBox("");
                activeHighlightRule = null;
                invalidateStaticCache();
                drawScene();
            });
            // Right-click to toggle persistent highlight for export
            checkbox.parentElement.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // Toggle: if already pinned to this rule, unpin; otherwise pin to this rule
                if (pinnedHighlightRule === ruleKey) {
                    pinnedHighlightRule = null;
                    checkbox.parentElement.classList.remove('rule-pinned');
                } else {
                    // Remove pinned class from any previously pinned rule
                    document.querySelectorAll('.rule-pinned').forEach(el => el.classList.remove('rule-pinned'));
                    pinnedHighlightRule = ruleKey;
                    checkbox.parentElement.classList.add('rule-pinned');
                }
                invalidateStaticCache();
                drawScene();
            });
        }
    }



    // Solid Colors for Palette Buttons (Better Visibility in Dark Mode)
    const paletteColors = {
        NEUTRAL: '#E2E8F0',
        GREEN: '#95D5B2',
        SPORT: '#A0CED9',
        WORKSHOP: '#FFCB77',
        FARMING: '#D6CAB2',
        SKELETON: '#718096', // Darker Grey for Road Tool
        AQUEDUCT: '#F6E05E',
        EXISTING_HOUSING: '#FFFFFF',
        NONE: '#4A5568'
    };

    for (const key in zoneTypes) {
        const zone = zoneTypes[key];
        const button = document.createElement('button');
        button.className = 'palette-button';
        // Use solid palette color if available, fallback to zone color
        button.style.backgroundColor = paletteColors[key] || zone.color;
        button.title = zone.name;

        // Visual fix for White Existing Housing button
        if (key === 'EXISTING_HOUSING') {
            button.style.border = '2px solid #000000';
        }

        button.addEventListener('mouseenter', () => updateInfoBox(zone.description));
        button.addEventListener('mouseleave', () => updateInfoBox(""));

        if (key === 'SKELETON') {
            button.innerHTML = 'S'; button.style.color = 'white'; button.style.fontSize = '16px'; button.style.fontWeight = 'bold';
        }
        if (zone === currentBrush) button.classList.add('active');

        button.addEventListener('click', () => {
            currentBrush = zone;
            freezeToolActive = false;
            canvas.style.cursor = '';
            document.querySelectorAll('.palette-button').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
        });
        paletteContainer.appendChild(button);
    }

    // --- MANUALLY ADD PATH TOOL ---
    const pathBtn = document.createElement('button');
    pathBtn.className = 'palette-button';
    pathBtn.style.backgroundColor = '#FFFFFF'; // White Background
    pathBtn.title = 'Path';
    // Visual Stroke Icon
    pathBtn.style.display = 'flex';
    pathBtn.style.alignItems = 'center';
    pathBtn.style.justifyContent = 'center';
    pathBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" style="display:block;">
        <path d="M2 22 L22 2" stroke="#D7CCC8" stroke-width="5" stroke-linecap="round" />
    </svg>`;
    // pathBtn.style.fontSize = '16px';

    pathBtn.addEventListener('mouseenter', () => updateInfoBox("Pedestrian Path: Draw paths on grid edges."));
    pathBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    pathBtn.addEventListener('click', () => {
        currentBrush = { name: 'PATH', color: '#D7CCC8' };
        freezeToolActive = false;
        canvas.style.cursor = '';
        document.querySelectorAll('.palette-button').forEach(btn => btn.classList.remove('active'));
        pathBtn.classList.add('active');
    });
    paletteContainer.appendChild(pathBtn);

    // --- MANUALLY ADD FREEZE TOOL ---
    const freezeBtn = document.createElement('button');
    freezeBtn.className = 'palette-button';
    freezeBtn.style.backgroundColor = '#90CAF9'; // Light blue
    freezeBtn.title = 'Freeze';
    freezeBtn.style.display = 'flex';
    freezeBtn.style.alignItems = 'center';
    freezeBtn.style.justifyContent = 'center';
    // Snowflake-style icon (6-pointed star)
    freezeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" style="display:block;">
        <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" stroke="#1565C0" stroke-width="2" stroke-linecap="round" />
        <circle cx="12" cy="12" r="2" fill="#1565C0" />
    </svg>`;

    freezeBtn.addEventListener('mouseenter', () => updateInfoBox("Freeze Tool: Click-drag to freeze plots. Frozen plots won't change during simulation. SHIFT + drag to unfreeze."));
    freezeBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    freezeBtn.addEventListener('click', () => {
        freezeToolActive = true;
        currentBrush = null;
        canvas.style.cursor = 'crosshair';
        document.querySelectorAll('.palette-button').forEach(btn => btn.classList.remove('active'));
        freezeBtn.classList.add('active');
    });
    paletteContainer.appendChild(freezeBtn);

    // --- MANUALLY ADD BOARD EDITOR TOOL ---
    const boardEditorBtn = document.createElement('button');
    boardEditorBtn.className = 'palette-button';
    boardEditorBtn.style.backgroundColor = '#E53E3E'; // Red
    boardEditorBtn.title = 'Board Editor';
    boardEditorBtn.style.display = 'flex';
    boardEditorBtn.style.alignItems = 'center';
    boardEditorBtn.style.justifyContent = 'center';
    // Eraser / Block icon
    boardEditorBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" style="display:block;">
        <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5zM16 8L2 22" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;

    boardEditorBtn.addEventListener('mouseenter', () => updateInfoBox("Board Editor: Click to add a plot. SHIFT + Click to remove a plot."));
    boardEditorBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    boardEditorBtn.addEventListener('click', () => {
        freezeToolActive = false;
        currentBrush = { name: 'BOARD_EDITOR', color: '#E53E3E' };
        canvas.style.cursor = 'crosshair';
        document.querySelectorAll('.palette-button').forEach(btn => btn.classList.remove('active'));
        boardEditorBtn.classList.add('active');
    });
    paletteContainer.appendChild(boardEditorBtn);

    // --- ERASE TOGGLE (touch replacement for SHIFT) ---
    // Stays on until tapped again; works together with the selected tool instead of replacing it.
    const eraseBtn = document.createElement('button');
    eraseBtn.className = 'palette-button erase-toggle';
    eraseBtn.style.backgroundColor = '#FFFFFF';
    eraseBtn.title = 'Erase';
    eraseBtn.style.display = 'flex';
    eraseBtn.style.alignItems = 'center';
    eraseBtn.style.justifyContent = 'center';
    // Eraser icon
    eraseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" style="display:block;">
        <path d="M7 21h10M5.5 14.5l7-7 5 5-7 7H8z M12.5 7.5l2-2a1.5 1.5 0 0 1 2 0l3 3a1.5 1.5 0 0 1 0 2l-2 2" stroke="#2D3748" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;

    eraseBtn.addEventListener('mouseenter', () => updateInfoBox("Erase: while on, zone brushes clear plots, the Path tool removes paths, the Board Editor removes plots and the Freeze tool unfreezes."));
    eraseBtn.addEventListener('mouseleave', () => updateInfoBox(""));

    eraseBtn.addEventListener('click', () => {
        eraseToolActive = !eraseToolActive;
        eraseBtn.classList.toggle('erase-on', eraseToolActive);
    });
    paletteContainer.appendChild(eraseBtn);

    const paramDivs = document.querySelectorAll('.param-group');
    paramDivs.forEach(div => {
        div.addEventListener('mouseenter', () => updateInfoBox(div.dataset.info));
        div.addEventListener('mouseleave', () => updateInfoBox(""));
    });


    canvas.addEventListener('mouseup', () => isPainting = false);
    canvas.addEventListener('mouseleave', () => isPainting = false);





    // Save zone layout to JSON
    function saveZoneLayout() {
        const layout = [];
        const savedPaths = []; // Save Paths too

        for (let y = 0; y < numRows; y++) {
            layout[y] = [];
            savedPaths[y] = [];
            for (let x = 0; x < numCols; x++) {
                if (dataGrid[y][x].name === 'REMOVED') {
                    layout[y][x] = 'REMOVED';
                } else {
                    layout[y][x] = zoneGrid[y][x].name;
                }
                // Save paths (if any)
                if (dataGrid[y][x].paths) {
                    savedPaths[y][x] = dataGrid[y][x].paths;
                } else {
                    savedPaths[y][x] = null;
                }
            }
        }

        const data = {
            version: '1.0',
            numRows,
            numCols,
            layout,
            paths: savedPaths // Add paths to export
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `zone_layout_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Load zone layout from JSON
    function loadZoneLayout(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.numRows !== numRows || data.numCols !== numCols) {
                    alert('Error: Grid size mismatch! Expected ' + numRows + 'x' + numCols + ', got ' + data.numRows + 'x' + data.numCols);
                    return;
                }
                applyZoneLayout(data);
                alert('Zone layout loaded successfully!');
            } catch (err) {
                alert('Error loading layout: ' + err.message);
            }
        };
        reader.readAsText(file);
    }

    // Apply a parsed layout (same grid size as the current grid)
    function applyZoneLayout(data) {
                // Reset ALL plots to EMPTY before loading zones
                for (let y = 0; y < numRows; y++) {
                    for (let x = 0; x < numCols; x++) {
                        const zoneName = data.layout[y][x];
                        if (zoneName === 'REMOVED') {
                            dataGrid[y][x] = { ...plotTypes.REMOVED, age: 0, treeCount: 0, occupiedQuad: -1 };
                            zoneGrid[y][x] = zoneTypes.NONE;
                        } else {
                            dataGrid[y][x] = { ...plotTypes.EMPTY, age: 0, treeCount: 0, occupiedQuad: -1 };
                            zoneGrid[y][x] = zoneTypes[zoneName] || zoneTypes.NEUTRAL;
                        }
                    }
                }

                // AFTER loading zones, update paths if present
                if (data.paths) {
                    for (let y = 0; y < numRows; y++) {
                        for (let x = 0; x < numCols; x++) {
                            if (data.paths[y][x]) {
                                dataGrid[y][x].paths = data.paths[y][x];
                            } else {
                                dataGrid[y][x].paths = { right: false, bottom: false };
                            }
                        }
                    }
                }

                // After loading zones, add EXISTING buildings to EXISTING_HOUSING zones
                for (let y = 0; y < numRows; y++) {
                    for (let x = 0; x < numCols; x++) {
                        if (zoneGrid[y][x].name === 'EXISTING_HOUSING') {
                            dataGrid[y][x] = { ...plotTypes.EXISTING, age: 0, treeCount: 0 };
                        }
                    }
                }

                // Recalculate derived state
                calculateTrees();
                calculateQuadrants(dataGrid);

                invalidateStaticCache();
                drawScene();
    }

    document.getElementById('saveLayout').addEventListener('click', saveZoneLayout);
    document.getElementById('loadLayoutBtn').addEventListener('click', () => {
        document.getElementById('layoutFile').click();
    });
    document.getElementById('layoutFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            loadZoneLayout(file);
        }
        e.target.value = ''; // Reset input to allow reloading same file
    });

    // Base Score Sliders Listeners
    if (sliders.baseScoreGreen) {
        sliders.baseScoreGreen.addEventListener('input', (e) => {
            simulationParameters.baseScoreGreen = parseFloat(e.target.value);
            sliderValues.baseScoreGreenValue.textContent = simulationParameters.baseScoreGreen.toFixed(1);
            applyScoringRule();
            if (!simulationInterval) drawScene();
        });
    }
    if (sliders.baseScoreFarming) {
        sliders.baseScoreFarming.addEventListener('input', (e) => {
            simulationParameters.baseScoreFarming = parseFloat(e.target.value);
            sliderValues.baseScoreFarmingValue.textContent = simulationParameters.baseScoreFarming.toFixed(1);
            applyScoringRule();
            if (!simulationInterval) drawScene();
        });
    }
    if (sliders.baseScoreSport) {
        sliders.baseScoreSport.addEventListener('input', (e) => {
            simulationParameters.baseScoreSport = parseFloat(e.target.value);
            sliderValues.baseScoreSportValue.textContent = simulationParameters.baseScoreSport.toFixed(1);
            applyScoringRule();
            if (!simulationInterval) drawScene();
        });
    }
    if (sliders.baseScoreWorkshop) {
        sliders.baseScoreWorkshop.addEventListener('input', (e) => {
            simulationParameters.baseScoreWorkshop = parseFloat(e.target.value);
            sliderValues.baseScoreWorkshopValue.textContent = simulationParameters.baseScoreWorkshop.toFixed(1);
            applyScoringRule();
            if (!simulationInterval) drawScene();
        });
    }

    // --- CONFIGURATION & STATE ---

    // PRNG State (Linear Congruential Generator)
    let currentSeed = Date.now() % 233280; // Default random seed on load
    const LCG_MULTIPLIER = 9301;
    const LCG_INCREMENT = 49297;
    const LCG_MODULUS = 233280;

    // Function to set the seed (e.g., from UI)
    function setSeed(seed) {
        currentSeed = seed % LCG_MODULUS;
    }

    // Spatial Hash PRNG Mode
    let useSpatialHash = true;
    let spatialCallCount = 0; // Tracks random calls per plot in a tick

    // A simple hash function to generate deterministic pseudo-random numbers based on coordinates and time
    function spatialRandomHash(seed, x, y, tick, offset) {
        // Fast, decent quality integer hash
        let h = seed ^ x ^ (y << 10) ^ (tick << 20) ^ (offset << 5);
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13;
        h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296; // Map to [0, 1)
    }

    // Deterministic random number generator replacing seededRandom()
    function seededRandom() {
        currentSeed = (currentSeed * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
        return currentSeed / LCG_MODULUS;
    }

    // Context-dependent random generator
    function nextRandom(x, y) {
        if (useSpatialHash) {
            spatialCallCount++;
            let master = simulationParameters.masterSeed;
            if (master === undefined) master = currentSeed;
            // Use seedInput.value as a fallback if masterSeed is not defined yet properly
            if (master === undefined) {
                const seedInputElem = document.getElementById('seedInput');
                if (seedInputElem) master = parseInt(seedInputElem.value) || 0;
            }
            return spatialRandomHash(master || 0, x, y, currentYear, spatialCallCount);
        } else {
            return seededRandom();
        }
    }
    // --- SEED UI LOGIC ---
    const spatialHashToggle = document.getElementById('spatialHashToggle');
    if (spatialHashToggle) {
        // Load preference if exists
        const storedSpatial = localStorage.getItem('spatialHashMode');
        if (storedSpatial !== null) {
            useSpatialHash = storedSpatial === 'true';
            spatialHashToggle.checked = useSpatialHash;
        }

        spatialHashToggle.addEventListener('change', (e) => {
            useSpatialHash = e.target.checked;
            localStorage.setItem('spatialHashMode', useSpatialHash);
        });
    }

    const seedInput = document.getElementById('seedInput');
    if (seedInput) {
        // Initialize with random seed generated on load
        seedInput.value = currentSeed;

        seedInput.addEventListener('change', (e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val)) {
                setSeed(val);
                pauseSimulation();
                currentMode = 'draw';
                modeBtn.textContent = 'START SIMULATION';
                startBtn.disabled = true; pauseBtn.disabled = true;
                canvas.style.cursor = 'crosshair';
                initialize();
            }
        });
    }

    // --- GRID SIZE UI LOGIC ---
    const gridColsInput = document.getElementById('gridColsInput');
    const gridRowsInput = document.getElementById('gridRowsInput');

    function applyGridSize() {
        const newCols = Math.max(5, parseInt(gridColsInput.value) || 30);
        const newRows = Math.max(5, parseInt(gridRowsInput.value) || 30);
        gridColsInput.value = newCols;
        gridRowsInput.value = newRows;
        if (newCols === numCols && newRows === numRows) return;

        pauseSimulation();
        currentMode = 'draw';
        modeBtn.textContent = 'START SIMULATION';
        startBtn.disabled = true; pauseBtn.disabled = true;
        canvas.style.cursor = 'crosshair';

        // Save old grids
        const oldDataGrid = dataGrid;
        const oldZoneGrid = zoneGrid;
        const oldFreezeGrid = freezeGrid;
        const oldCols = numCols;
        const oldRows = numRows;

        numCols = newCols;
        numRows = newRows;

        // Scale viewport world bounds for large grids
        viewport.worldWidth = Math.max(2000, (numCols + numRows) * BASE_TILE_WIDTH);
        viewport.worldHeight = Math.max(2000, (numCols + numRows) * BASE_TILE_HEIGHT);

        initialize();

        // Restore old data where possible
        for (let y = 0; y < Math.min(oldRows, numRows); y++) {
            for (let x = 0; x < Math.min(oldCols, numCols); x++) {
                dataGrid[y][x] = { ...oldDataGrid[y][x] };
                bufferGrid[y][x] = { ...oldDataGrid[y][x] };
                zoneGrid[y][x] = oldZoneGrid[y][x];
                freezeGrid[y][x] = oldFreezeGrid[y][x];
            }
        }
        drawScene();
    }

    if (gridColsInput && gridRowsInput) {
        gridColsInput.value = numCols;
        gridRowsInput.value = numRows;
        gridColsInput.addEventListener('change', applyGridSize);
        gridRowsInput.addEventListener('change', applyGridSize);
    }

    // --- LOD TOGGLE ---
    const lodToggle = document.getElementById('lodToggle');
    if (lodToggle) {
        lodToggle.checked = lodEnabled;
        lodToggle.addEventListener('change', () => {
            lodEnabled = lodToggle.checked;
            localStorage.setItem('lodEnabled', lodEnabled);
            currentLOD = getLODLevel(viewport.scale.x);
            requestRender();
        });
    }

    // --- EXPORT FUNCTIONALITY ---
    const exportBtn = document.getElementById('exportBtn');
    const exportMenu = document.getElementById('exportMenu');
    // CORRECTED IDs based on HTML
    const exportBtnCurrent = document.getElementById('expCurrentView');
    const exportBtnAll = document.getElementById('expEntireMap');

    if (exportBtn && exportMenu) {
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle('visible');
            // Close settings if open
            if (typeof settingsMenu !== 'undefined' && settingsMenu) settingsMenu.classList.remove('visible');
        });

        // Settings button should also close export menu
        const settingsBtnRef = document.getElementById('settingsBtn');
        if (settingsBtnRef) {
            settingsBtnRef.addEventListener('click', () => {
                exportMenu.classList.remove('visible');
            });
        }
    }

    // Close menus on outside click
    document.addEventListener('click', (e) => {
        if (exportMenu && exportMenu.classList.contains('visible')) {
            if (!exportMenu.contains(e.target) && !exportBtn.contains(e.target)) {
                exportMenu.classList.remove('visible');
            }
        }
    });

    const handleExport = async (scope) => {
        // Ensure Visual Rotation (Quadrants) are up-to-date
        calculateQuadrants(dataGrid);

        // Capture State BEFORE try block so finally can always access them
        const originalResolution = app.renderer.resolution;
        const originalWidth = app.renderer.width / originalResolution; // CSS width
        const originalHeight = app.renderer.height / originalResolution; // CSS height
        const originalZoom = viewport.scale.x;
        const originalCenter = viewport.center.clone();
        const originalScreenW = viewport.screenWidth;
        const originalScreenH = viewport.screenHeight;
        const savedLOD = currentLOD;

        // Query GPU limits.
        // IMPORTANT: MAX_VIEWPORT_DIMS (the actual framebuffer size) is often SMALLER than MAX_TEXTURE_SIZE.
        // If renderW exceeds MAX_VIEWPORT_DIMS, the GL only renders into part of the canvas — causing partial exports.
        const gl = app.renderer.gl;
        const maxTexture = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;
        const maxViewport = gl ? gl.getParameter(gl.MAX_VIEWPORT_DIMS) : [4096, 4096];
        const GPU_MAX = Math.min(maxTexture, maxViewport[0], maxViewport[1]);
        console.log('[EXPORT] GPU — MAX_TEXTURE_SIZE:', maxTexture, ' MAX_VIEWPORT_DIMS:', maxViewport, ' → effective limit:', GPU_MAX);

        try {
            // 1. Get User Options
            const resRadio = document.querySelector('input[name="exportRes"]:checked');
            const formatRadio = document.querySelector('input[name="exportFmt"]:checked');
            const resValue = resRadio ? resRadio.value : '1';
            const isTiled = resValue === 'tile4';
            const multiplier = isTiled ? 10 : (parseInt(resValue) || 1);
            const mimeType = formatRadio ? formatRadio.value : 'image/jpeg';
            const ext = mimeType === 'image/png' ? 'png' : 'jpg';
            const wantTransparent = mimeType === 'image/png';

            // Handle background: transparent for PNG, opaque for JPG
            const originalAlpha = app.renderer.background.alpha;
            const originalColor = app.renderer.background.color;
            if (wantTransparent) {
                app.renderer.background.alpha = 0;
            }

            // Force full detail
            currentLOD = 0;

            // Isometric grid world dimensions (for current-view layout)
            // Uses BASE_TILE dimensions because tileWidth/tileHeight may already be zoomed.
            const halfTileW = BASE_TILE_WIDTH / 2;
            const halfTileH = BASE_TILE_HEIGHT / 2;
            const slabH = BASE_TILE_HEIGHT * 0.75; // slab thickness in world units
            const minX = -numRows * halfTileW;
            const maxX = numCols * halfTileW;
            const minY = 0;
            const maxY = (numCols + numRows) * halfTileH + slabH; // include slab!
            const worldW = maxX - minX;
            const worldH = maxY - minY;

            // Fixed export widths per quality level
            const exportSizes = { 1: 1920, 2: 3840, 4: 5760, 8: 11520, 10: 14400 };
            const baseSize = exportSizes[multiplier] || 1920;

            let renderW, renderH, renderZoom, renderCenterX, renderCenterY;

            if (scope === 'current') {
                const aspect = originalWidth / originalHeight;
                renderW = Math.round(baseSize);
                renderH = Math.round(baseSize / aspect);
                renderCenterX = originalCenter.x;
                renderCenterY = originalCenter.y;
                renderZoom = originalZoom * (renderW / originalWidth);
            } else {
                const margin = 50;
                const gridAspect = worldW / worldH;
                renderW = Math.round(baseSize);
                renderH = Math.round(baseSize / gridAspect);
                renderCenterX = (minX + maxX) / 2;
                renderCenterY = (minY + maxY) / 2;
                const zoomX = renderW / (worldW + margin * 2);
                const zoomY = renderH / (worldH + margin * 2);
                renderZoom = Math.min(zoomX, zoomY);
            }

            // Clamp to GPU reported limit (safety net before actual probe)
            if (renderW > GPU_MAX || renderH > GPU_MAX) {
                const s = Math.min(GPU_MAX / renderW, GPU_MAX / renderH);
                renderW = Math.floor(renderW * s);
                renderH = Math.floor(renderH * s);
                renderZoom = renderZoom * s;
            }

            // Temporarily remove CSS size constraints so the browser does not cap
            // the WebGL drawing buffer (max-height: 100% would limit drawingBufferHeight
            // to the visible container height, cutting off the bottom of the export).
            const exportCanvas = app.view;
            const savedCssWidth  = exportCanvas.style.width;
            const savedCssHeight = exportCanvas.style.height;
            const savedCssMaxW   = exportCanvas.style.maxWidth;
            const savedCssMaxH   = exportCanvas.style.maxHeight;
            const savedCssPos    = exportCanvas.style.position;
            exportCanvas.style.width     = renderW + 'px';
            exportCanvas.style.height    = renderH + 'px';
            exportCanvas.style.maxWidth  = 'none';
            exportCanvas.style.maxHeight = 'none';
            exportCanvas.style.position  = 'fixed'; // take out of layout flow

            // Probe the true GPU drawing-buffer cap by requesting the large size
            // and reading what was actually allocated.
            app.renderer.resolution = 1;
            app.renderer.resize(renderW, renderH);
            const actualW = gl ? gl.drawingBufferWidth  : renderW;
            const actualH = gl ? gl.drawingBufferHeight : renderH;
            if (actualW !== renderW || actualH !== renderH) {
                // Correct Pixi's projection matrix to match the real buffer size.
                app.renderer.resize(actualW, actualH);
                console.warn(`[EXPORT] GPU capped to ${actualW}×${actualH} (requested ${renderW}×${renderH}). Projection corrected.`);
            }

            // ── Grid geometry (same for all tiles) ─────────────────────────────
            // The isometric grid spans from top corner (0,0) to:
            //   right corner  = isoToScreen(numCols, 0)    → x offset = +numCols * tileWidth/2
            //   left corner   = isoToScreen(0, numRows)    → x offset = -numRows * tileWidth/2
            //   bottom corner = isoToScreen(numCols,numRows)→ y offset = (numCols+numRows)*tileHeight/2
            // The slab (3D base) extends slabThickness = tileHeight*0.75 BELOW the bottom corner.
            const slabThicknessExport = tileHeight * 0.75;
            const gridSpanX = (numCols + numRows) * tileWidth / 2;   // full horizontal extent
            const gridSpanY = (numCols + numRows) * tileHeight / 2 + slabThicknessExport; // +slab
            const gridMinX  = -numRows * tileWidth / 2;              // x of left corner
            const gridMinY  = 0;
            const tileMargin = 60; // px of padding inside each tile image

            // ── Helper: read WebGL framebuffer → 2D canvas (Y-flip corrected) ────
            // gl.readPixels() reads directly from the GPU framebuffer, completely
            // bypassing CSS canvas constraints that limit drawingBufferHeight.
            // WebGL origin is bottom-left, 2D canvas is top-left → rows must be flipped.
            const glReadToCanvas = (w, h) => {
                const pixels = new Uint8Array(4 * w * h);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

                const offscreen = document.createElement('canvas');
                offscreen.width  = w;
                offscreen.height = h;
                const offCtx = offscreen.getContext('2d');
                const imgData = offCtx.createImageData(w, h);
                const src = pixels;
                const dst = imgData.data;
                const rowBytes = w * 4;
                // Flip rows: WebGL row 0 is the bottom screen row
                for (let row = 0; row < h; row++) {
                    const srcOff = (h - 1 - row) * rowBytes;
                    const dstOff = row * rowBytes;
                    dst.set(src.subarray(srcOff, srcOff + rowBytes), dstOff);
                }
                offCtx.putImageData(imgData, 0, 0);
                return offscreen;
            };

            // Helper: render one tile (tx, ty) of a (tilesX × tilesY) grid and download it.
            // fullW/fullH = total pixel dimensions of the composite image.
            // offsetX0/offsetY0 = worldGrid screen-space origin for tile (0,0).
            const renderAndDownloadTile = async (tx, ty, tilesX, tilesY, fullW, fullH, offsetX0, offsetY0, expScale, filenameBase) => {
                // For this tile, shift the worldGrid so its (tx,ty) quadrant maps to screen (0,0).
                const tileOffX = offsetX0 - tx * actualW;
                const tileOffY = offsetY0 - ty * actualH;

                viewport.removeChild(worldGrid);
                viewport.visible = false;
                app.stage.addChild(worldGrid);
                worldGrid.scale.set(expScale);
                worldGrid.position.set(tileOffX, tileOffY);

                buildWorld(true);
                app.renderer.render(app.stage);

                // Restore immediately after render
                app.stage.removeChild(worldGrid);
                worldGrid.scale.set(1);
                worldGrid.position.set(0, 0);
                viewport.addChild(worldGrid);
                viewport.visible = true;

                // Read directly from GL framebuffer (bypasses CSS canvas constraints)
                const offscreen = glReadToCanvas(actualW, actualH);

                // Download this tile
                const label = tilesX > 1 ? `_tile${ty * tilesX + tx + 1}of${tilesX * tilesY}_row${ty + 1}col${tx + 1}` : '';
                const filename = `${filenameBase}${label}.${ext}`;
                const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;

                await new Promise((resolve, reject) => {
                    offscreen.toBlob((blob) => {
                        if (!blob) { reject(new Error('Tile export failed.')); return; }
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.download = filename;
                        link.href = url;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        setTimeout(() => URL.revokeObjectURL(url), 5000);
                        resolve();
                    }, mimeType, quality);
                });
            };

            // ── Render ──────────────────────────────────────────────────────────
            const filenameBase = `simulation_export_${scope}_${isTiled ? 'tile4max' : resValue + 'x'}`;
            const quality = mimeType === 'image/jpeg' ? 0.92 : undefined;

            if (scope !== 'current') {
                if (isTiled) {
                    // 4-TILE TILED EXPORT: 2×2 grid, full image = 2×actualW × 2×actualH
                    const tilesX = 2, tilesY = 2;
                    const fullW = tilesX * actualW;
                    const fullH = tilesY * actualH;

                    // Compute exportScale and origin for the FULL composite image
                    const expScale = Math.min(
                        (fullW - tileMargin * 2) / gridSpanX,
                        (fullH - tileMargin * 2) / gridSpanY
                    );
                    const scaledW = gridSpanX * expScale;
                    const scaledH = gridSpanY * expScale;
                    const offsetX0 = (fullW - scaledW) / 2 - gridMinX * expScale;
                    const offsetY0 = (fullH - scaledH) / 2 - gridMinY * expScale;

                    console.log(`[EXPORT] 4-tile: full=${fullW}×${fullH}, scale=${expScale.toFixed(4)}, origin=(${offsetX0.toFixed(0)},${offsetY0.toFixed(0)})`);

                    for (let ty = 0; ty < tilesY; ty++) {
                        for (let tx = 0; tx < tilesX; tx++) {
                            await renderAndDownloadTile(tx, ty, tilesX, tilesY, fullW, fullH, offsetX0, offsetY0, expScale, filenameBase);
                        }
                    }

                } else {
                    // SINGLE-IMAGE ENTIRE MAP
                    const expScale = Math.min(
                        (actualW - tileMargin * 2) / gridSpanX,
                        (actualH - tileMargin * 2) / gridSpanY
                    );
                    const scaledW = gridSpanX * expScale;
                    const scaledH = gridSpanY * expScale;
                    const offsetX0 = (actualW - scaledW) / 2 - gridMinX * expScale;
                    const offsetY0 = (actualH - scaledH) / 2 - gridMinY * expScale;

                    await renderAndDownloadTile(0, 0, 1, 1, actualW, actualH, offsetX0, offsetY0, expScale, filenameBase);
                }

            } else {
                // CURRENT VIEW: viewport-based render
                const actualZoom = originalZoom * (actualW / originalWidth);
                viewport.resize(actualW, actualH);
                viewport.setZoom(actualZoom);
                viewport.moveCenter(renderCenterX, renderCenterY);
                buildWorld(true);
                app.renderer.render(app.stage);
                viewport.resize(originalScreenW, originalScreenH);

                // Read directly from GL framebuffer (bypasses CSS canvas constraints)
                const offscreen = glReadToCanvas(actualW, actualH);

                await new Promise((resolve, reject) => {
                    offscreen.toBlob((blob) => {
                        if (!blob) { reject(new Error('Export failed.')); return; }
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.download = `${filenameBase}.${ext}`;
                        link.href = url;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        setTimeout(() => URL.revokeObjectURL(url), 5000);
                        resolve();
                    }, mimeType, quality);
                });
            }

            // Restore background state
            app.renderer.background.alpha = originalAlpha;
            app.renderer.background.color = originalColor;

        } catch (err) {
            console.error("Export Failed:", err);
            alert("Export failed: " + err.message);
        } finally {
            // Restore ALL state reliably
            currentLOD = savedLOD;

            // Restore canvas CSS constraints before resizing back
            if (typeof exportCanvas !== 'undefined' && exportCanvas) {
                exportCanvas.style.width     = savedCssWidth;
                exportCanvas.style.height    = savedCssHeight;
                exportCanvas.style.maxWidth  = savedCssMaxW;
                exportCanvas.style.maxHeight = savedCssMaxH;
                exportCanvas.style.position  = savedCssPos;
            }

            app.renderer.resolution = originalResolution;
            app.renderer.resize(originalWidth, originalHeight);
            viewport.resize(originalScreenW, originalScreenH);
            viewport.setZoom(originalZoom);
            viewport.moveCenter(originalCenter.x, originalCenter.y);

            // Force full redraw
            buildWorld();
            resizeCanvas();
            requestRender();
        }
    };

    // Attach Listeners if Elements Exist
    if (exportBtnCurrent) exportBtnCurrent.addEventListener('click', () => handleExport('current'));
    else console.error("Export Button Current not found!");

    if (exportBtnAll) exportBtnAll.addEventListener('click', () => handleExport('all'));
    else console.error("Export Button All not found!");

    // --- NEO-SWISS BLUEPRINT: STATUS SYNC ---
    const simStatusText = document.getElementById('sim-status-text');
    const modeToggleBtn = document.getElementById('mode-toggle'); // Big Start Button

    if (simStatusText) {
        if (startBtn) startBtn.addEventListener('click', () => simStatusText.textContent = "RUNNING ▶");
        if (pauseBtn) pauseBtn.addEventListener('click', () => simStatusText.textContent = "PAUSED ⏸");
        if (resetBtn) resetBtn.addEventListener('click', () => simStatusText.textContent = "READY ⏹");

    }

    // Enabling Sliders
    setupParameterControls();

    // Initial Resize to set up Grid Coordinates
    resizeCanvas(false);

    // Enabling Sliders
    // setupParameterControls(); // Removed duplicate call

    initialize();
    if (EXPO_MODE) applyExpoLayout();

    // EXHIBITION: after EXPO_IDLE_MS without input, start fresh for the next visitor.
    // A page reload also restores all sliders, rules and settings; if the site cannot be reached (no wifi),
    // only the grid is reset so the tablet never ends up on a browser error page.
    if (EXPO_MODE) {
        let lastInput = Date.now();
        let idleHandled = true; // a fresh page already is the start screen
        const markInput = () => { lastInput = Date.now(); idleHandled = false; };
        ['pointerdown', 'keydown', 'wheel'].forEach(t => window.addEventListener(t, markInput, { capture: true, passive: true }));
        setInterval(async () => {
            if (idleHandled || Date.now() - lastInput < EXPO_IDLE_MS) return;
            idleHandled = true;
            ['darkMode', 'showShadows', 'lodEnabled', 'spatialHashMode', 'skipIntro'].forEach(k => localStorage.removeItem(k));
            try {
                const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
                if (r.ok) { location.reload(); return; }
            } catch (err) { /* offline: soft reset below */ }
            wasPausedByInteraction = false; // closing the modal must not restart the simulation
            closeModal();
            resetGrid(true);
            checkIntro();
        }, 5000);
    }
    // --- NEO-SWISS BLUEPRINT: TOOLBAR VISIBILITY HANDLED IN switchTab() NOW ---

    // --- NEO-SWISS BLUEPRINT: DYNAMIC MARQUEE ---
    const marqueeContent = document.querySelector('.marquee-content');

    function updateMarquee() {
        if (!marqueeContent) return;
        // User requested to remove active rule text and keep it empty but visible
        marqueeContent.innerHTML = "&nbsp;";
    }

    // Call initially
    updateMarquee();

    // Hook into rule changes
    // Check if ruleCheckboxes exists before iterating
    if (typeof ruleCheckboxes !== 'undefined') {
        for (const [id, ruleKey] of Object.entries(ruleCheckboxes)) {
            const checkbox = document.getElementById(id);
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    simulationRules[ruleKey] = e.target.checked;
                    drawScene();
                    updateMarquee(); // Update marquee on change
                });
            }
        }
    }

    function updateProgressBar() {
        if (!progressBar) return;
        // tickProgress goes 0->100
        progressBar.style.width = `${tickProgress}%`;
    }

    function updateProgressBarFixed() {
        updateProgressBar();
    }

    // Start the Game Loop Last
    gameLoop();
    function updateStatisticsRefined() {
        let counts = { GREEN: 0, FARMING: 0, SPORT: 0, WORKSHOP: 0, EMPTY: 0 };
        let activePlots = 0;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const p = dataGrid[y][x];
                const z = zoneGrid[y][x];
                // Only count active/participating plots (exclude REMOVED, EXISTING, NONE, SKELETON, AQUEDUCT, EXISTING_HOUSING)
                if (p.name === 'REMOVED' || p.name === 'EXISTING' ||
                    z.name === 'NONE' || z.name === 'SKELETON' ||
                    z.name === 'AQUEDUCT' || z.name === 'EXISTING_HOUSING') continue;
                activePlots++;
                const plotName = p.name;
                if (counts[plotName] !== undefined) counts[plotName]++;
            }
        }
        if (activePlots > 0) {
            // 1. Calculate Raw Percentages
            let rawPercentages = {};
            let currentSum = 0;
            let largestCategory = 'EMPTY';
            let largestValue = -1;

            for (const typeName in counts) {
                let raw = (counts[typeName] / activePlots) * 100;
                // Round to 1 decimal place generally
                let rounded = Math.round(raw * 10) / 10;
                rawPercentages[typeName] = rounded;
                currentSum += rounded;

                if (raw > largestValue) {
                    largestValue = raw;
                    largestCategory = typeName;
                }
            }

            // 2. Fix Rounding Errors (Ensure Sum is exactly 100.0)
            const diff = 100.0 - currentSum;
            // Float safety
            if (Math.abs(diff) > 0.001) {
                // Adjust largest category
                rawPercentages[largestCategory] = parseFloat((rawPercentages[largestCategory] + diff).toFixed(1));
            }

            // 3. Update DOM
            for (const typeName in rawPercentages) {
                const percentage = rawPercentages[typeName];
                const span = statDisplays[typeName];
                if (span) {
                    // Animate Percentage (1 Decimal)
                    animateValue(span, percentage, 600, (val) => val.toFixed(1) + "%");

                    const parentDiv = span.parentElement;
                    let color = plotTypes[typeName].color;
                    if (typeName === 'EMPTY') color = '#dddddd';
                    parentDiv.style.background = `linear-gradient(90deg, ${color} ${percentage}%, #ffffff ${percentage}%)`;
                }
            }
        }
    }

    // --- SMART ACCORDION ANIMATION ---
    // Fixes the "one-time-only" animation issue by manually controlling the height transition
    document.querySelectorAll('.config-section summary').forEach(summary => {
        summary.addEventListener('click', (e) => {
            e.preventDefault(); // Prevent default instant toggle
            const details = summary.parentElement;

            // Check if currently open
            const isOpen = details.hasAttribute('open');
            const content = details.querySelector('.section-content') || details.querySelector('summary + div');

            if (!content) return;

            if (isOpen) {
                // CLOSE ANIMATION
                // 1. Lock the current height (to animate FROM)
                content.style.height = content.scrollHeight + 'px';

                // 2. Force reflow to ensure the browser registers the start height
                requestAnimationFrame(() => {
                    // 3. Set height to 0 (animate TO)
                    content.style.height = '0px';
                    content.style.opacity = '0';
                    content.style.paddingTop = '0px';
                    content.style.paddingBottom = '0px';
                });

                // 4. Wait for transition to finish before removing 'open'
                content.addEventListener('transitionend', function onEnd() {
                    if (details.hasAttribute('open')) { // Ensure we didn't click again
                        details.removeAttribute('open');
                    }
                    content.style.height = ''; // Clean up inline styles
                    content.style.opacity = '';
                    content.style.paddingTop = '';
                    content.style.paddingBottom = '';
                    content.removeEventListener('transitionend', onEnd);
                }, { once: true });

            } else {
                // OPEN ANIMATION
                // 1. Set open attribute so content is rendered (but we want it hidden first)
                details.setAttribute('open', '');

                // 2. MEASURE FIRST (Fix for bounce: Capture height WITH padding)
                const targetHeight = content.scrollHeight;

                // 3. Reset styles to initial state (0 height)
                content.style.height = '0px';
                content.style.opacity = '0';
                content.style.paddingTop = '0px';
                content.style.paddingBottom = '0px';

                // 4. Force reflow
                requestAnimationFrame(() => {
                    // 5. Animate TO target height
                    // EXPANSION FIX: Override bouncy CSS transition with smooth ease-out
                    content.style.transition = 'all 0.4s ease-out';

                    content.style.height = targetHeight + 'px';
                    content.style.opacity = '1';
                    content.style.paddingTop = '16px'; // Match CSS padding
                    content.style.paddingBottom = '16px'; // Match CSS padding

                    // 5. Cleanup after animation to allow auto-height (if content changes)
                    content.addEventListener('transitionend', function onEnd(e) {
                        if (e.propertyName !== 'height') return;
                        content.style.height = 'auto';
                        content.style.transition = ''; // Restore CSS transition for other interactions
                        content.removeEventListener('transitionend', onEnd);
                    });

                });
            }
        });
    });


    // Helper: Odometer Year Animation V2 (Persistent DOM to fix jitter)
    function animateYearOdometerV2(obj, end, duration = 600) {
        if (!obj) return;

        let endVal = parseInt(end) || 0;
        // Try to get start value from last known state or parsing text
        let startVal = parseInt(obj.dataset.lastVal) || parseInt(obj.textContent.replace(/[^\d]/g, '')) || 0;

        obj.dataset.lastVal = endVal;

        if (startVal === endVal) {
            // Ensure structure if missing on initial load
            if (obj.children.length === 0 && obj.textContent.trim()) {
                // lazy hydration if needed
            }
            return;
        }

        if (Math.abs(endVal - startVal) > 5) {
            obj.textContent = endVal;
            return;
        }

        let startStr = startVal.toString();
        let endStr = endVal.toString();
        const maxLength = Math.max(startStr.length, endStr.length);
        startStr = startStr.padStart(maxLength, '0');
        endStr = endStr.padStart(maxLength, '0');

        // HYDRATION: Ensure consistent block structure exists
        const hasText = Array.from(obj.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
        if (hasText || obj.children.length !== maxLength || obj.style.display !== 'inline-flex') {
            obj.innerHTML = '';
            obj.style.display = 'inline-flex';
            obj.style.lineHeight = '1';

            for (let i = 0; i < maxLength; i++) {
                const span = document.createElement('div');
                span.style.display = 'inline-block';
                span.style.width = '0.6em';
                span.style.textAlign = 'center';
                span.style.position = 'relative';
                span.style.height = '1em';
                span.style.lineHeight = '1';
                span.style.overflow = 'hidden';
                span.textContent = startStr[i];
                obj.appendChild(span);
            }
        }

        // ANIMATE DIGITS
        const children = Array.from(obj.children);

        for (let i = 0; i < maxLength; i++) {
            const wrapper = children[i];
            const startChar = startStr[i];
            const endChar = endStr[i];

            if (startChar === endChar) {
                if (wrapper.children.length > 0) {
                    wrapper.textContent = startChar;
                } else if (wrapper.textContent !== startChar) {
                    wrapper.textContent = startChar;
                }
            } else {
                wrapper.textContent = '';

                const slider = document.createElement('div');
                slider.style.position = 'absolute';
                slider.style.left = '0';
                slider.style.width = '100%';
                slider.style.transition = `transform ${duration}ms cubic-bezier(0.4, 0.0, 0.2, 1)`;

                const newSpan = document.createElement('div');
                newSpan.textContent = endChar;
                newSpan.style.height = '1em';
                newSpan.style.lineHeight = '1';

                const oldSpan = document.createElement('div');
                oldSpan.textContent = startChar;
                oldSpan.style.height = '1em';
                oldSpan.style.lineHeight = '1';

                slider.appendChild(newSpan);
                slider.appendChild(oldSpan);

                slider.style.transform = 'translateY(-1em)';

                wrapper.appendChild(slider);

                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        slider.style.transform = 'translateY(0)';
                    });
                });

                setTimeout(() => {
                    if (wrapper.contains(slider)) {
                        wrapper.textContent = endChar;
                    }
                }, duration + 50);
            }
        }
    }

    // --- EXPORT TO BLENDER (JSON) ---

    // HELPER: Deterministic Random
    const getSeededRandom = (seed) => {
        const x = Math.sin(seed) * 10000;
        return x - Math.floor(x);
    };

    // HELPER: Rotate Local Point
    const rotatePoint = (x, y, turns) => {
        let rx = x;
        let ry = y;
        for (let t = 0; t < turns; t++) {
            const tmp = rx;
            rx = -ry;
            ry = tmp;
        }
        return { x: rx, y: ry };
    };

    const GRID_TO_METER = 3.33; // 10m tile / 3 units approx

    // HELPER: Generate Workshop Props (Includes Cars)
    const getWorkshopProps = (x, y, plot) => {
        const props = [];
        const layout = workshopLayouts.get(`${x},${y}`);
        const variant = layout ? layout.variant : 0;
        const rotation = layout ? layout.rotation : 0;

        // OFFSETS (In Tile Units, converted to Meters)
        // Calculated from drawing_helpers.js visual logic
        // Garage (Var 0): Center (0, -0.15)
        // Social (Var 1): Center (-0.15, -0.15)
        // Shed (Var 2): Center (0, -0.30)
        // Lumber (Var 2): Center (0, 0.20)
        // Car (Var 0): Center (0, 0.31) [Base position relative to garage frame]

        let buildingOffset = { x: 0, y: 0 };
        let buildingType = 'workshop_garage';

        if (variant === 0) {
            buildingType = 'workshop_garage';
            buildingOffset = { x: 0, y: -0.15 };
        } else if (variant === 1) {
            buildingType = 'workshop_social';
            buildingOffset = { x: -0.15, y: -0.15 };
        } else if (variant === 2) {
            buildingType = 'workshop_shed_canopy';
            buildingOffset = { x: 0, y: -0.30 };
        }

        if (plot.mergedWith) buildingType += '_merged';

        // 1. MAIN BUILDING
        // Apply Rotation to Offset
        const rBuild = rotatePoint(buildingOffset.x, buildingOffset.y, rotation);

        props.push({
            type: buildingType,
            local_x: rBuild.x * GRID_TO_METER,
            local_y: rBuild.y * GRID_TO_METER,
            rotation: rotation * 90,
            variant: variant,
            scale: 1.0
        });

        // 2. EXTRA OBJECTS (Single Plots Only mostly)
        if (!plot.mergedWith) {
            if (variant === 0) {
                // CAR
                // Car is at (0, 0.31) relative to Tile Center (approx)
                // BUT Drawing Helper says: cX = -0.09, cY = 0.15 + carOffset.
                // Center ~ (0, 0.31).
                const carBase = { x: 0, y: 0.31 };
                // There is a 'carOffset' in drawing logic if facing path (-0.10).
                // We'll ignore dynamic path checking for now and assume standard or handle simply.
                // Let's stick to base.
                const rCar = rotatePoint(carBase.x, carBase.y, rotation);
                props.push({
                    type: 'car_sedan',
                    local_x: rCar.x * GRID_TO_METER,
                    local_y: rCar.y * GRID_TO_METER,
                    rotation: rotation * 90,
                    variant: 0,
                    scale: 1.0
                });
            } else if (variant === 2) {
                // LUMBER
                // Center (0, 0.20)
                const lumberBase = { x: 0, y: 0.20 };
                const rLumb = rotatePoint(lumberBase.x, lumberBase.y, rotation);
                props.push({
                    type: 'wood_stack',
                    local_x: rLumb.x * GRID_TO_METER,
                    local_y: rLumb.y * GRID_TO_METER,
                    rotation: rotation * 90,
                    variant: 0,
                    scale: 1.0
                });
            }
        }

        return props;
    };

    // HELPER: Generate Sport Props
    const getSportProps = (x, y, plot) => {
        const props = [];
        const layout = sportLayouts.get(`${x},${y}`);
        const variant = layout ? layout.variant : 0;
        const rotation = layout ? layout.rotation : 0;

        // Offsets from Visual Logic
        // Soccer (0): (-0.4, 0)
        // Basket (1): (-0.4, 0)
        // Workout (2): (-0.2, 0)
        // Tennis (3): (0.5, 0) [Merged Seam]

        let typeName = 'sport_soccer_goal';
        let offset = { x: -0.4, y: 0 };

        if (variant === 0) {
            typeName = 'sport_soccer_goal';
            offset = { x: -0.4, y: 0 };
        } else if (variant === 1) {
            typeName = 'sport_basketball_hoop';
            offset = { x: -0.4, y: 0 };
        } else if (variant === 2) {
            typeName = 'sport_workout_station';
            offset = { x: -0.2, y: 0 };
        } else if (variant === 3) {
            // TENNIS uses 'sport_tennis_net' but logic is tricky.
            // Only Master draws it? Or Center?
            // Visual helper draws it at uSeam=0.5.
            // If this is Master, we generate it.
            typeName = 'sport_tennis_net';
            offset = { x: 0.5, y: 0 };
            // Tennis usually spans, so rotation matters.
            // Net is on the seam.
        }

        const rOff = rotatePoint(offset.x, offset.y, rotation);

        // Only generate if Single OR Master (for Tennis)
        // Existing logic filters slaves in main loop

        props.push({
            type: typeName,
            local_x: rOff.x * GRID_TO_METER,
            local_y: rOff.y * GRID_TO_METER,
            rotation: rotation * 90,
            variant: variant,
            scale: 1.0
        });

        // Add 2nd Goal for Soccer? (Usually spread across field, but logic here is per tile)
        // Visuals only draw ONE goal per tile in Variant 0. 

        return props;
    };

    // HELPER: Generate Farming Props
    const getFarmingProps = (x, y, plot) => {
        const props = [];
        if (plot.mergedWith) {
            // GREENHOUSE (Merged)
            // Center is on the seam.
            // Horizontal Merge (Width 2): Seam is at X + 0.5 (Right of Master)
            // Vertical Merge (Height 2): Seam is at Y + 0.5 (Bottom of Master)

            let offset = { x: 0, y: 0 };
            let rot = 0;

            if (Math.abs(plot.mergedWith.x - x) > 0) {
                // Horizontal (Width 2)
                offset = { x: 0.5, y: 0 }; // Right edge of master (u=0.5)
                rot = 0;
            } else {
                // Vertical (Height 2)
                // Visual logic for vertical merge?
                // Usually u=0, v=0.5?
                // drawing_helpers uses axisMain/axisPerp. 
                // Let's assume standard grid: Vertical means Y+1. Seam is v=0.5.
                offset = { x: 0, y: 0.5 };
                rot = 90;
            }

            // No rotation applied to offset because 0.5 is already in Grid Space relative to Master
            // Wait, Grid Space vs Rotated Space.
            // Master has rotation 0 usually for Merged sets?
            // Actually, greenhouses define their own rotation based on merge axis.

            // Convert Grid Offset to Meter
            // If u is X, v is Y.

            props.push({
                type: 'greenhouse',
                local_x: offset.x * GRID_TO_METER, // 0.5 * 3.33 = ~1.66m
                local_y: offset.y * GRID_TO_METER,
                rotation: rot,
                variant: 1,
                scale: 1.0
            });

        } else {
            // Single Farm Shed
            // Position based on Quadrant
            // Quad 0: (-0.33, -0.33)
            // Quad 1: (0.33, -0.33)
            // Quad 2: (0.33, 0.33)
            // Quad 3: (-0.33, 0.33)

            let offset = { x: 0, y: 0 };
            const q = plot.occupiedQuad;
            let rot = 0;

            if (q === 0) { offset = { x: -0.33, y: -0.33 }; rot = 0; }
            else if (q === 1) { offset = { x: 0.33, y: -0.33 }; rot = 90; }
            else if (q === 2) { offset = { x: 0.33, y: 0.33 }; rot = 180; }
            else if (q === 3) { offset = { x: -0.33, y: 0.33 }; rot = 270; }

            props.push({
                type: 'farming_shed',
                local_x: offset.x * GRID_TO_METER,
                local_y: offset.y * GRID_TO_METER,
                rotation: rot,
                variant: 0,
                scale: 1.0
            });
        }
        return props;
    };

    // HELPER: Generate Merged Park Props (Export)
    const getMergedParkProps = (x, y, plot) => {
        const props = [];
        // Determine Center of Merged Area relative to this Master tile
        // If horizontal: partner is at x+1. Center is at x+0.5.
        // If vertical: partner is at y+1. Center is at y+0.5.
        const isHorizontal = (plot.mergedWith.x !== x);
        const cx = isHorizontal ? 0.5 : 0;
        const cy = isHorizontal ? 0 : 0.5;

        // 1. Picnic Table (Center)
        props.push({
            type: 'picnic_table',
            local_x: cx * GRID_TO_METER,
            local_y: cy * GRID_TO_METER,
            rotation: isHorizontal ? 0 : 90,
            variant: 0,
            scale: 1.0
        });

        // 2. Trees (Edge Spread - simplistic)
        // 4 Trees near corners of the 2-tile area
        // Long axis: +/- 0.8. Short axis: +/- 0.3.
        const offsets = [
            { u: -0.8, v: -0.3 }, { u: 0.8, v: 0.3 },
            { u: -0.8, v: 0.3 }, { u: 0.8, v: -0.3 }
        ];

        let seed = x * 31 + y * 17;
        const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xFFFFFF; return (seed / 0xFFFFFF); };

        offsets.forEach(off => {
            let tx = off.u;
            let ty = off.v;

            // If vertical, swap axes for world space (u is long axis)
            if (!isHorizontal) {
                // Vertical: x is short (-0.5..0.5), y is long (-1..1)
                tx = off.v; // short
                ty = off.u; // long
            }

            // Jitter
            tx += (rand() - 0.5) * 0.2;
            ty += (rand() - 0.5) * 0.2;

            const finalX = (cx + tx) * GRID_TO_METER;
            const finalY = (cy + ty) * GRID_TO_METER;

            // Simple Distance Check from Table (Center)
            const dx = finalX - (cx * GRID_TO_METER);
            const dy = finalY - (cy * GRID_TO_METER);
            if (Math.hypot(dx, dy) > 1.0) { // Safety radius
                props.push({
                    type: 'tree_pine_01',
                    local_x: finalX,
                    local_y: finalY,
                    rotation: rand() * 360,
                    variant: 0,
                    scale: 0.8 + rand() * 0.4
                });
            }
        });

        return props;
    };

    // HELPER: Generate Vegetation Props
    const getVegetationProps = (x, y, plot) => {
        const props = [];

        let variant = (plot.variant !== undefined) ? plot.variant : 0;
        if (plot.name !== 'GREEN') variant = 0;
        // 0: Park, 1: Garden, 2: Wilderness

        let baseCount = plot.treeCount || 0;
        if (plot.name === 'GREEN' && baseCount < 1) baseCount = 1;

        if (variant === 1) baseCount = 9; // Garden fills
        else if (variant === 2) baseCount = 9; // Wilderness fills

        const fillOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        let seed = x * 71523 + y * 92719;

        // Shuffle for Park/Wilderness
        if (variant !== 1) {
            for (let i = fillOrder.length - 1; i > 0; i--) {
                const j = Math.floor(getSeededRandom(seed++) * (i + 1));
                [fillOrder[i], fillOrder[j]] = [fillOrder[j], fillOrder[i]];
            }
        }

        // Plot Rotation
        const rot = (plot.rotation !== undefined) ? plot.rotation : ((x * 7 + y * 13) % 4);

        let drawnCount = 0;
        for (let i = 0; i < 9; i++) {
            if (drawnCount >= baseCount) break;
            const posIndex = fillOrder[i];

            // 1. Logical Grid Position (-1, 0, 1) relative to center
            const lRow = Math.floor(posIndex / 3);
            const lCol = posIndex % 3;
            // Map 0..2 to -1..1
            // 0 -> -1 (Left/Top)
            // 1 -> 0
            // 2 -> 1 (Right/Bottom)
            // Note: Visual logic used lCol-1.
            // But we need to be careful with Tile scale (3 units).
            // -1 represents -1/3 of a tile? Yes. (-0.33)

            const u = (lCol - 1) * 0.33;
            const v = (lRow - 1) * 0.33;

            // 2. Rotate
            const rotated = rotatePoint(u, v, rot % 4);
            const rx = rotated.x;
            const ry = rotated.y;

            // 3. Check for Exclusions (Garden Paths etc)
            if (variant === 1) {
                // Skip Paved (5,8), Grass (6,7), Buffer (4)
                if ([4, 5, 6, 7, 8].includes(posIndex)) {
                    // In visual logic, this consumes a "slot" but doesn't draw.
                    // But for export, we just skip pushing.
                    // IMPORTANT: Does it consume 'drawnCount'?
                    // Visual: "if ... continue" inside the loop that iterates UP TO baseCount?
                    // No, the visual loop iterates 9 times and breaks if drawnCount >= baseCount.
                    // But if it skips, it doesn't increment drawnCount.
                    // WAIT. If it continues, it does NOT increment.
                    // So we should try to match that behavior.
                    continue;
                }
            }

            // 4. Decide Type (Tree vs Bush)
            let type = 'tree_pine_01';
            let isBush = false;

            if (variant === 1) {
                // Garden: Index 0 is Tree, rest Bush
                if (i === 0) type = 'tree_pine_01';
                else { type = 'bush_round'; isBush = true; }
            } else if (variant === 2) {
                // Wilderness: First 3 are Trees, rest Scrub
                if (i < 3) type = 'tree_pine_01';
                else { type = 'bush_round'; isBush = true; }
            } else {
                // Park: All Trees
                type = 'tree_pine_01';
            }

            // Scale Jitter
            const hSeed = (x * 37 + y * 13 + posIndex * 7) % 3;
            let scale = 1.0;
            if (hSeed === 0) scale = 0.8;
            else if (hSeed === 2) scale = 1.2;

            if (isBush) scale *= 0.7;

            props.push({
                type: type,
                local_x: rx * GRID_TO_METER,
                local_y: ry * GRID_TO_METER,
                rotation: 0,
                variant: 0,
                scale: scale
            });

            drawnCount++;
        }

        return props;
    };

    // MASTER GENERATOR
    const generatePropsForPlot = (plot, x, y, zone) => {
        const allProps = [];

        // 1. Existing Buildings
        if (plot.name === 'EXISTING') {
            allProps.push({ type: 'existing_building', local_x: 0, local_y: 0, rotation: 0, variant: 0, scale: 1 });
            return allProps;
        }

        // 2. Primary Objects
        if (plot.name === 'WORKSHOP') {
            allProps.push(...getWorkshopProps(x, y, plot));
        } else if (plot.name === 'SPORT') {
            allProps.push(...getSportProps(x, y, plot));
        } else if (plot.name === 'FARMING') {
            allProps.push(...getFarmingProps(x, y, plot));
        } else if (zone.name === 'SKELETON') {
            // Street props? Street lights?
            // For now, stick to basic street floor (handled in root type)
        }

        // 3. Secondary/Vegetation
        if (plot.name === 'GREEN' || (plot.treeCount > 0 && plot.name !== 'EXISTING')) {
            if (!plot.mergedWith) {
                allProps.push(...getVegetationProps(x, y, plot));
            } else if (plot.name === 'GREEN' && plot.mergedWith) {
                // Merged Green (Park) - Only specific props for Master
                // Master logic: Left (x < partner.x) or Top (y < partner.y)
                const isMaster = (plot.mergedWith.x > x) || (plot.mergedWith.y > y);
                if (isMaster) {
                    allProps.push(...getMergedParkProps(x, y, plot));
                }
            }
        }

        // 4. Aqueduct (Additive)
        if (zone.name === 'AQUEDUCT') {
            const rot = (zone.orientation === 'horizontal' ? 0 : 90);
            allProps.push({ type: 'aqueduct_arch', local_x: 0, local_y: 0, rotation: rot, variant: 0, scale: 1 });
        }

        // 5. Boundaries (Fences/Hedges)
        const boundaryProps = getBoundaryProps(x, y, plot);
        allProps.push(...boundaryProps);

        return allProps;
    };

    // HELPER: Generate Boundary Props (Fences/Hedges)
    const getBoundaryProps = (x, y, plot) => {
        const props = [];
        if (plot.name === 'EMPTY' || plot.name === 'EXISTING') return props;

        // Check RIGHT (x+1) and BOTTOM (y+1) neighbors
        const checkSides = [
            { dir: 'right', dx: 1, dy: 0, ox: 0.5, oy: 0, rot: 90 },
            { dir: 'bottom', dx: 0, dy: 1, ox: 0, oy: 0.5, rot: 0 }
        ];

        checkSides.forEach(side => {
            const nx = x + side.dx;
            const ny = y + side.dy;

            // Bounds check
            if (nx >= numCols || ny >= numRows) return;

            const neighbor = dataGrid[ny][nx];
            if (!neighbor || neighbor.name === 'EMPTY' || neighbor.name === 'EXISTING') return;

            // Merged Logic: Skip internal edges of merged plots
            if (plot.mergedWith && plot.mergedWith.x === nx && plot.mergedWith.y === ny) return;
            if (plot.mergedWith && neighbor.mergedWith &&
                plot.mergedWith.x === neighbor.mergedWith.x &&
                plot.mergedWith.y === neighbor.mergedWith.y) return;

            // Path Logic: Skip if path exists on this edge
            if ((side.dir === 'right' && plot.paths && plot.paths.right) ||
                (side.dir === 'bottom' && plot.paths && plot.paths.bottom)) {
                // Path exists on this edge, so NO Fence/Hedge. 
                // We also DO NOT export 'path_walkway' anymore (Vertex Loop handles paths).
                return;
            }

            // Type Logic
            let type = 'hedge_high'; // Default (Privacy)

            if (plot.name === 'GREEN' && neighbor.name === 'GREEN') {
                type = 'hedge_low';
            } else if (plot.name === 'FARMING' && neighbor.name === 'FARMING') {
                type = 'fence_low'; // Rustic
            } else if (plot.name === 'WORKSHOP' && neighbor.name === 'WORKSHOP') {
                type = 'fence_low'; // Industrial
            } else if (plot.name === 'SPORT' && neighbor.name === 'SPORT') {
                return; // No fence between sports
            }

            // Shortening Logic: Check Vertices for perpendicular paths
            let isShort = false;
            // Declare path-side variables at this scope so rotation logic can use them
            let pathOnLeft = false, pathOnRight = false, pathOnTop = false, pathOnBottom = false;

            if (side.dir === 'bottom') {
                // Edge is from (x, y+1) to (x+1, y+1) [Top-Left coordinate system for Vertices]
                // Vertices: Left = (x, y+1), Right = (x+1, y+1)

                // Check Left Vertex (x, y+1) for Perpendicular Paths (Vertical: N/S)
                const hasN_L = (x > 0) && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right;
                const hasS_L = (x > 0 && y + 1 < numRows) && dataGrid[y + 1][x - 1].paths && dataGrid[y + 1][x - 1].paths.right;

                // Check Right Vertex (x+1, y+1) for Perpendicular Paths (Vertical: N/S)
                const hasN_R = (dataGrid[y][x].paths && dataGrid[y][x].paths.right);
                const hasS_R = (y + 1 < numRows) && (dataGrid[y + 1][x].paths && dataGrid[y + 1][x].paths.right);

                pathOnLeft = hasN_L || hasS_L;
                pathOnRight = hasN_R || hasS_R;
                if (pathOnLeft || pathOnRight) isShort = true;

            } else if (side.dir === 'right') {
                // Edge is from (x+1, y) to (x+1, y+1)
                // Vertices: Top = (x+1, y), Bottom = (x+1, y+1)

                // Check Top Vertex (x+1, y) for Perpendicular Paths (Horizontal: W/E)
                const hasW_T = (y > 0) && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom;
                const hasE_T = (y > 0 && x + 1 < numCols) && dataGrid[y - 1][x + 1].paths && dataGrid[y - 1][x + 1].paths.bottom;

                // Check Bottom Vertex (x+1, y+1) for Perpendicular Paths (Horizontal: W/E)
                const hasW_B = (dataGrid[y][x].paths && dataGrid[y][x].paths.bottom);
                const hasE_B = (x + 1 < numCols) && (dataGrid[y][x + 1].paths && dataGrid[y][x + 1].paths.bottom);

                pathOnTop = hasW_T || hasE_T;
                pathOnBottom = hasW_B || hasE_B;
                if (pathOnTop || pathOnBottom) isShort = true;
            }

            if (isShort) type += '_short';

            // Determine rotation: for _short fences, flip based on which vertex has the path gap
            // Assumption: the _short 3D model has the gap on the Positive X (Right/End) side
            let finalRotation = side.rot;
            if (isShort) {
                if (side.dir === 'bottom') {
                    // Default rotation 0: gap on right (x+1 side)
                    // If path is only on left (x-1 side), flip to 180
                    if (pathOnLeft && !pathOnRight) finalRotation = 180;
                } else if (side.dir === 'right') {
                    // Default rotation 90: gap on bottom (y+1 side)
                    // If path is only on top (y-1 side), flip to 270
                    if (pathOnTop && !pathOnBottom) finalRotation = 270;
                }
            }

            props.push({
                type: type,
                local_x: side.ox * GRID_TO_METER,
                local_y: side.oy * GRID_TO_METER,
                rotation: finalRotation,
                variant: 0,
                scale: 1.0
            });
        });

        return props;
    };

    function exportBlenderJSON() {
        console.log("Starting Grid Export...");
        try {
            if (!dataGrid || dataGrid.length === 0) {
                alert("No data found.");
                return;
            }

            // Ensure Visual Rotation (Quadrants) are up-to-date
            calculateQuadrants(dataGrid);

            const exportData = [];

            for (let y = 0; y < numRows; y++) {
                for (let x = 0; x < numCols; x++) {
                    const plot = dataGrid[y][x];
                    const zone = zoneGrid[y][x];
                    if (!plot) continue;

                    // SKIP MERGED SLAVES
                    // We only export the Master tile for merged plots.
                    if (plot.mergedWith) {
                        const isSlave = (plot.mergedWith.x < x) || (plot.mergedWith.y < y);
                        // Logic check: if mergedWith x < my x, I am to the right. Master is Left. I am Slave.
                        // if mergedWith y < my y, I am below. Master is Top. I am Slave.
                        if (isSlave) continue;
                    }

                    // DETERMINE FLOOR TYPE (ROOT)
                    let floorType = 'empty_plot';

                    if (plot.name === 'WORKSHOP') floorType = 'workshop_floor';
                    else if (plot.name === 'SPORT') floorType = 'sport_floor';
                    else if (plot.name === 'FARMING') floorType = 'farming_floor'; // or grass
                    else if (plot.name === 'GREEN') floorType = 'grass_floor';
                    else if (plot.name === 'EXISTING') floorType = 'paved_floor';
                    else if (zone.name === 'SKELETON') floorType = 'street_floor';
                    else if (zone.name === 'AQUEDUCT') floorType = 'water_floor'; // or grass underneath? Usually grass.

                    // Specific overrides
                    if (plot.name === 'GREEN') {
                        if (plot.variant === 1) floorType = 'garden_floor';
                        if (plot.variant === 2) floorType = 'wilderness_floor';
                    }

                    // STANDARD MERGED FLOOR TYPES
                    if (plot.mergedWith) {
                        // Only Green plots (Grass, Garden, Wilderness) become generic 'green_floor'
                        // Farming plots must remain 'farming_floor' for specific 3D models (crops)
                        if (plot.name === 'GREEN') {
                            floorType = 'green_floor';
                        }
                    }

                    // GENERATE PROPS
                    const locationProps = generatePropsForPlot(plot, x, y, zone);

                    // DIMENSIONS
                    let width = 1;
                    let height = 1;
                    let rootRotation = 0;

                    if (plot.mergedWith) {
                        // Master Logic
                        if (Math.abs(plot.mergedWith.x - x) > 0) {
                            width = 2; height = 1;
                        } else {
                            width = 1; height = 2;
                        }
                    }

                    // Workshpop/Sport Rotation for Floor Texture?
                    if (plot.name === 'WORKSHOP') {
                        const layout = workshopLayouts.get(`${x},${y}`);
                        rootRotation = layout ? layout.rotation * 90 : 0;
                    } else if (plot.name === 'FARMING' && !plot.mergedWith) {
                        const q = plot.occupiedQuad;
                        if (q === 1) rootRotation = 90;
                        else if (q === 2) rootRotation = 180;
                        else if (q === 3) rootRotation = 270;
                    }

                    // SCALE FACTOR (Clipping Fix)
                    // Check for paths on all 4 sides to determine if we need to shrink the floor
                    let hasPath = false;
                    const pRight = plot.paths && plot.paths.right;
                    const pBottom = plot.paths && plot.paths.bottom;
                    const pLeft = (x > 0) && dataGrid[y][x - 1].paths && dataGrid[y][x - 1].paths.right;
                    const pTop = (y > 0) && dataGrid[y - 1][x].paths && dataGrid[y - 1][x].paths.bottom;

                    if (pRight || pBottom || pLeft || pTop) {
                        hasPath = true;
                    }

                    const scaleFactor = hasPath ? 0.9 : 1.0;

                    exportData.push({
                        x: x,
                        y: y,
                        type: floorType,       // ROOT IS FLOOR
                        rotation: rootRotation,
                        width: width,
                        height: height,
                        scale_factor: scaleFactor, // NEW: Shrink if path exists
                        props: locationProps.map(p => ({
                            type: p.type,
                            local_x: parseFloat(p.local_x.toFixed(3)),
                            local_y: parseFloat(p.local_y.toFixed(3)),
                            rotation: p.rotation,
                            scale: parseFloat(p.scale.toFixed(2)),
                            variant: p.variant
                        }))
                    });
                }
            }

            // VERTEX LOOP (PATHS)
            // Iterate all vertices to place path nodes (Crossings, T-Splits, etc.)
            for (let vy = 0; vy <= numRows; vy++) {
                for (let vx = 0; vx <= numCols; vx++) {
                    // Identify Incident Paths
                    // N: Edge going North from Vertex (Right Edge of Tile vx-1, vy-1)
                    // S: Edge going South from Vertex (Right Edge of Tile vx-1, vy)
                    // W: Edge going West from Vertex (Bottom Edge of Tile vx-1, vy-1)
                    // E: Edge going East from Vertex (Bottom Edge of Tile vx, vy-1)

                    const hasN = (vx > 0 && vy > 0) && dataGrid[vy - 1][vx - 1].paths && dataGrid[vy - 1][vx - 1].paths.right;
                    const hasS = (vx > 0 && vy < numRows) && dataGrid[vy][vx - 1].paths && dataGrid[vy][vx - 1].paths.right;
                    const hasW = (vx > 0 && vy > 0) && dataGrid[vy - 1][vx - 1].paths && dataGrid[vy - 1][vx - 1].paths.bottom;
                    const hasE = (vx < numCols && vy > 0) && dataGrid[vy - 1][vx].paths && dataGrid[vy - 1][vx].paths.bottom;

                    const count = (hasN ? 1 : 0) + (hasS ? 1 : 0) + (hasW ? 1 : 0) + (hasE ? 1 : 0);
                    if (count === 0) continue;

                    let type = null;
                    let rot = 0;

                    if (count === 4) {
                        type = 'path_crossing';
                        rot = 0;
                    } else if (count === 3) {
                        type = 'path_tsplit';
                        if (!hasS) rot = 0;       // W-N-E (Top)
                        else if (!hasW) rot = 90; // N-E-S (Right)
                        else if (!hasN) rot = 180;// E-S-W (Bottom)
                        else if (!hasE) rot = 270;// S-W-N (Left)
                    } else if (count === 2) {
                        if (hasN && hasS) { type = 'path_straight'; rot = 0; }
                        else if (hasW && hasE) { type = 'path_straight'; rot = 90; }
                        else {
                            type = 'path_corner';
                            if (hasN && hasE) rot = 0;
                            else if (hasE && hasS) rot = 90;
                            else if (hasS && hasW) rot = 180;
                            else if (hasW && hasN) rot = 270;
                        }
                    } else if (count === 1) {
                        type = 'path_end';
                        // End usually points "Forward" to the connection? 
                        // Or is it a cap?
                        // Assuming "Leg" of end connects to the path.
                        // If Path is N, Leg must point N.
                        if (hasN) rot = 0;
                        else if (hasE) rot = 90;
                        else if (hasS) rot = 180;
                        else if (hasW) rot = 270;
                    }

                    if (type) {
                        // Push Vertex Node
                        // Attaching to Tile (vx, vy) coordinate (Top-Left corner)
                        // Local offset: -0.5 tile width (-1.665m approx)
                        exportData.push({
                            x: vx,
                            y: vy,
                            type: 'empty_plot', // Dummy host
                            rotation: 0,
                            width: 1,
                            height: 1,
                            scale_factor: 1.0,
                            props: [{
                                type: type,
                                local_x: -0.5 * GRID_TO_METER,
                                local_y: -0.5 * GRID_TO_METER,
                                rotation: rot,
                                scale: 1.0,
                                variant: 0
                            }]
                        });
                    }
                }
            }

            console.log(`Generated export with ${exportData.length} tiles.`);

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadAnchorNode.setAttribute("download", `city_sim_blender_${timestamp}.json`);
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();

        } catch (e) {
            console.error("Export Error:", e);
            alert("Export Failed: " + e.message);
        }
    }

    // Bind Export Listener (Internal)
    const blenderExportBtn = document.getElementById('exportBlenderBtn');
    if (blenderExportBtn) {
        blenderExportBtn.addEventListener('click', exportBlenderJSON);
        console.log("Export Button Bound (Internal)");
    }

});