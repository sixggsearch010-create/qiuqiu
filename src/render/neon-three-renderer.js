import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const CELL_SCALE = 4.05;
const DEFAULT_WORLD_SIZE = 8000;
const ASSET_PATHS = {
    playerCore: "/assets/neon/player_core.glb",
    foodCrystal: "/assets/neon/food_crystal.glb",
    virusSpike: "/assets/neon/virus_spike.glb",
    boundaryTower: "/assets/neon/boundary_tower.glb",
    powerupCore: "/assets/neon/powerup_core.glb",
    arenaModule: "/assets/neon/arena_module.glb"
};

const QUALITY = {
    high: {
        pixelRatio: 1.75,
        bloomStrength: 1.45,
        bloomRadius: 0.55,
        bloomThreshold: 0.08,
        foodLimit: 1300,
        trailLimit: 10,
        particleScale: 1,
        composer: true
    },
    medium: {
        pixelRatio: 1.25,
        bloomStrength: 0.95,
        bloomRadius: 0.42,
        bloomThreshold: 0.16,
        foodLimit: 850,
        trailLimit: 7,
        particleScale: 0.65,
        composer: true
    },
    low: {
        pixelRatio: 1,
        bloomStrength: 0.45,
        bloomRadius: 0.26,
        bloomThreshold: 0.24,
        foodLimit: 520,
        trailLimit: 4,
        particleScale: 0.35,
        composer: false
    }
};

function radiusFromMass(mass) {
    return Math.sqrt(Math.max(1, mass || 1)) * CELL_SCALE;
}

function colorFromNumber(value, fallback = 0x22d3ee) {
    const color = Number.isFinite(value) ? value : fallback;
    return color & 0xffffff;
}

function disposeObject(object) {
    if (!object) return;
    object.traverse?.(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(material => material.dispose?.());
        else child.material?.dispose?.();
    });
}

export function createRenderSnapshot(gameScene) {
    const localPlayer = gameScene.getPlayerCenter ? gameScene.getPlayerCenter() : { x: DEFAULT_WORLD_SIZE / 2, y: DEFAULT_WORLD_SIZE / 2, mass: 0 };
    const isLocal = owner => gameScene.isLocalPlayer ? gameScene.isLocalPlayer(owner) : owner === gameScene.localPlayerId;
    const cellThreats = new Map((gameScene.currentThreats || []).map(threat => [threat.owner, threat]));
    return {
        worldSize: gameScene.getWorldSize ? gameScene.getWorldSize() : DEFAULT_WORLD_SIZE,
        localPlayerId: gameScene.localPlayerId,
        localPlayer,
        cells: (gameScene.cells || []).map(cell => ({
            id: cell.id,
            owner: cell.owner,
            name: cell.name,
            x: cell.x,
            y: cell.y,
            mass: cell.mass,
            radius: cell.radius || radiusFromMass(cell.mass),
            color: colorFromNumber(cell.color),
            local: isLocal(cell.owner),
            threat: cellThreats.has(cell.owner),
            threatScore: cellThreats.get(cell.owner)?.score || 0,
            trail: (cell.trail || []).slice(-12).map(point => ({ x: point.x, y: point.y, t: point.t }))
        })),
        food: gameScene.food || [],
        viruses: gameScene.viruses || [],
        powerups: gameScene.powerups || [],
        hotspots: gameScene.hotspots || [],
        bounties: (gameScene.bounties || []).map(bounty => ({
            ...bounty,
            target: gameScene.getBountyTargetPoint ? gameScene.getBountyTargetPoint(bounty) : (bounty.target || bounty.targetPoint || null)
        })),
        effects: gameScene.effects || [],
        threats: gameScene.currentThreats || [],
        comboCount: gameScene.comboCount || 0,
        comboActive: gameScene.comboCount >= 2 && gameScene.time && gameScene.time.now - gameScene.comboLastKillTime < 2600,
        gravityActive: !!gameScene.gravityActive,
        antigravityActive: !!gameScene.antigravityActive,
        activeSkin: gameScene.activeSkin || null
    };
}

export class NeonThreeRenderer {
    constructor({ mount, worldSize = DEFAULT_WORLD_SIZE, quality = "high", onAction = () => {} }) {
        this.mount = mount;
        this.worldSize = worldSize;
        this.qualityName = QUALITY[quality] ? quality : "high";
        this.quality = QUALITY[this.qualityName];
        this.onAction = onAction;
        this.disposed = false;
        this.now = 0;
        this.assets = {};
        this.cellMeshes = new Map();
        this.powerupMeshes = new Map();
        this.hotspotMeshes = new Map();
        this.trailLines = new Map();
        this.virusMeshes = [];
        this.effectMeshes = [];
        this.arenaModules = [];
        this.materialCache = new Map();
        this.tmpObject = new THREE.Object3D();
        this.tmpColor = new THREE.Color();
        this.cameraTarget = new THREE.Vector3(worldSize / 2, 0, worldSize / 2);
        this.cameraVelocity = new THREE.Vector3();
        this.cameraTheta = 0;
        this.cameraPhi = Math.PI * 0.36;
        this.cameraZoomBias = 1;
        this.cameraDistance = 1300;

        this.mount.innerHTML = "";
        this.mount.style.display = "block";
        this.mount.classList.add("neon-three-active");

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x030712);
        this.scene.fog = new THREE.FogExp2(0x030712, 0.00016);

        this.camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 8, 28000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.18;
        this.renderer.setClearColor(0x030712, 1);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
        this.mount.appendChild(this.renderer.domElement);

        this.composer = new EffectComposer(this.renderer);
        this.renderPass = new RenderPass(this.scene, this.camera);
        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            this.quality.bloomStrength,
            this.quality.bloomRadius,
            this.quality.bloomThreshold
        );
        this.composer.addPass(this.renderPass);
        this.composer.addPass(this.bloomPass);

        this.createMaterials();
        this.createEnvironment();
        this.createLocalPlayerGuides();
        this.createCameraResetButton();
        this.bindInput();
        this.loadAssets();
        this.setQuality(this.qualityName);
    }

    createMaterials() {
        this.materials = {
            ground: new THREE.MeshBasicMaterial({ color: 0x050b18, transparent: true, opacity: 0.98 }),
            trail: new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.72 }),
            threatTrail: new THREE.LineBasicMaterial({ color: 0xfb7185, transparent: true, opacity: 0.74 }),
            localOutline: new THREE.MeshBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.32, side: THREE.BackSide }),
            beacon: new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.42, depthWrite: false }),
            ring: new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.72, depthWrite: false }),
            threatRing: new THREE.MeshBasicMaterial({ color: 0xfb7185, transparent: true, opacity: 0.58, depthWrite: false }),
            hotspot: new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
            bounty: new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
            shockwave: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
            gravity: new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.3, depthWrite: false }),
            antigravity: new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.3, depthWrite: false })
        };
        this.geometries = {
            unitSphere: new THREE.SphereGeometry(1, 40, 24),
            unitSphereLow: new THREE.SphereGeometry(1, 24, 16),
            food: new THREE.OctahedronGeometry(1, 0),
            virus: new THREE.IcosahedronGeometry(1, 1),
            ring: new THREE.TorusGeometry(1, 0.035, 12, 96),
            beacon: new THREE.CylinderGeometry(0.45, 0.45, 1, 24, 1, true),
            powerRing: new THREE.TorusGeometry(1, 0.12, 12, 40),
            powerCore: new THREE.IcosahedronGeometry(1, 1),
            tower: new THREE.ConeGeometry(38, 240, 6)
        };
    }

    createEnvironment() {
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.worldSize, this.worldSize), this.materials.ground);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(this.worldSize / 2, -3, this.worldSize / 2);
        this.scene.add(ground);

        const grid = new THREE.GridHelper(this.worldSize, 80, 0x22d3ee, 0x172554);
        grid.position.set(this.worldSize / 2, 0, this.worldSize / 2);
        grid.material.transparent = true;
        grid.material.opacity = 0.26;
        this.scene.add(grid);

        const majorGrid = new THREE.GridHelper(this.worldSize, 16, 0xf472b6, 0x312e81);
        majorGrid.position.set(this.worldSize / 2, 1, this.worldSize / 2);
        majorGrid.material.transparent = true;
        majorGrid.material.opacity = 0.16;
        this.scene.add(majorGrid);

        const hemi = new THREE.HemisphereLight(0x67e8f9, 0x0f172a, 1.9);
        this.scene.add(hemi);
        const key = new THREE.DirectionalLight(0xa78bfa, 1.8);
        key.position.set(-0.3, 1, 0.5);
        this.scene.add(key);
        const rim = new THREE.PointLight(0x22d3ee, 420, this.worldSize * 1.2, 1.2);
        rim.position.set(this.worldSize * 0.5, 900, this.worldSize * 0.5);
        this.scene.add(rim);

        this.createBoundary();
        this.createArenaModules();
    }

    createBoundary() {
        const wallMaterial = new THREE.MeshBasicMaterial({ color: 0xfb7185, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
        const wallHeight = 260;
        const wallGeo = new THREE.PlaneGeometry(this.worldSize, wallHeight);
        const wallPositions = [
            { x: this.worldSize / 2, z: 0, ry: 0 },
            { x: this.worldSize / 2, z: this.worldSize, ry: Math.PI },
            { x: 0, z: this.worldSize / 2, ry: Math.PI / 2 },
            { x: this.worldSize, z: this.worldSize / 2, ry: -Math.PI / 2 }
        ];
        for (const wallInfo of wallPositions) {
            const wall = new THREE.Mesh(wallGeo, wallMaterial.clone());
            wall.position.set(wallInfo.x, wallHeight / 2, wallInfo.z);
            wall.rotation.y = wallInfo.ry;
            this.scene.add(wall);
        }

        this.boundaryTowers = [];
        const step = 1000;
        for (let p = 0; p <= this.worldSize; p += step) {
            this.addBoundaryTower(p, 0);
            this.addBoundaryTower(p, this.worldSize);
            if (p > 0 && p < this.worldSize) {
                this.addBoundaryTower(0, p);
                this.addBoundaryTower(this.worldSize, p);
            }
        }
    }

    addBoundaryTower(x, z) {
        const material = new THREE.MeshStandardMaterial({
            color: 0xfb7185,
            emissive: 0xfb7185,
            emissiveIntensity: 1.1,
            roughness: 0.34,
            metalness: 0.2
        });
        const mesh = new THREE.Mesh(this.geometries.tower, material);
        mesh.position.set(x, 120, z);
        this.scene.add(mesh);
        this.boundaryTowers.push(mesh);
    }

    createArenaModules() {
        const material = new THREE.MeshStandardMaterial({
            color: 0x172554,
            emissive: 0x1d4ed8,
            emissiveIntensity: 0.42,
            roughness: 0.5,
            metalness: 0.16
        });
        const positions = [
            [this.worldSize * 0.18, this.worldSize * 0.18],
            [this.worldSize * 0.82, this.worldSize * 0.18],
            [this.worldSize * 0.18, this.worldSize * 0.82],
            [this.worldSize * 0.82, this.worldSize * 0.82]
        ];
        for (const [x, z] of positions) {
            const module = new THREE.Mesh(this.assets.arenaModule || new THREE.BoxGeometry(240, 22, 240), material.clone());
            module.position.set(x, 4, z);
            module.scale.setScalar(1);
            this.scene.add(module);
            this.arenaModules.push(module);
        }
    }

    createLocalPlayerGuides() {
        this.localRing = new THREE.Mesh(this.geometries.ring, this.materials.ring);
        this.localRing.rotation.x = Math.PI / 2;
        this.scene.add(this.localRing);

        this.localBeacon = new THREE.Mesh(this.geometries.beacon, this.materials.beacon);
        this.localBeacon.visible = false;
        this.scene.add(this.localBeacon);

        this.localArrow = new THREE.Mesh(new THREE.ConeGeometry(18, 56, 3), new THREE.MeshBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.82 }));
        this.localArrow.visible = false;
        this.scene.add(this.localArrow);
    }

    createCameraResetButton() {
        this.resetButton = document.createElement("button");
        this.resetButton.type = "button";
        this.resetButton.className = "three-camera-reset";
        this.resetButton.textContent = "重置视角";
        this.resetButton.addEventListener("click", () => this.resetCamera());
        this.mount.appendChild(this.resetButton);
    }

    bindInput() {
        const canvas = this.renderer.domElement;
        this._onContextMenu = event => event.preventDefault();
        this._onPointerDown = event => {
            if (event.button === 2) {
                this.dragging = true;
                this.dragStart = { x: event.clientX, y: event.clientY };
                event.preventDefault();
                return;
            }
            if (event.button === 0) this.onAction("split");
            if (event.button === 1) this.onAction("eject");
        };
        this._onPointerMove = event => {
            if (!this.dragging || !this.dragStart) return;
            const dx = event.clientX - this.dragStart.x;
            const dy = event.clientY - this.dragStart.y;
            this.dragStart.x = event.clientX;
            this.dragStart.y = event.clientY;
            this.cameraTheta -= dx * 0.0045;
            this.cameraPhi = THREE.MathUtils.clamp(this.cameraPhi + dy * 0.0035, 0.2, Math.PI * 0.48);
        };
        this._onPointerUp = event => {
            if (event.button === 2) this.dragging = false;
        };
        this._onWheel = event => {
            this.cameraZoomBias = THREE.MathUtils.clamp(this.cameraZoomBias + Math.sign(event.deltaY) * 0.12, 0.58, 2.4);
            event.preventDefault();
        };
        this._onResize = () => this.resize(window.innerWidth, window.innerHeight);
        this._onContextLost = event => {
            event.preventDefault();
            this.contextLost = true;
        };
        this._onContextRestored = () => {
            this.contextLost = false;
            this.resize(window.innerWidth, window.innerHeight);
        };
        canvas.addEventListener("contextmenu", this._onContextMenu);
        canvas.addEventListener("pointerdown", this._onPointerDown);
        canvas.addEventListener("wheel", this._onWheel, { passive: false });
        canvas.addEventListener("webglcontextlost", this._onContextLost);
        canvas.addEventListener("webglcontextrestored", this._onContextRestored);
        window.addEventListener("pointermove", this._onPointerMove);
        window.addEventListener("pointerup", this._onPointerUp);
        window.addEventListener("resize", this._onResize);
    }

    async loadAssets() {
        const loader = new GLTFLoader();
        await Promise.all(Object.entries(ASSET_PATHS).map(async ([key, path]) => {
            try {
                const gltf = await loader.loadAsync(path);
                const mesh = gltf.scene.getObjectByProperty("type", "Mesh");
                if (mesh?.geometry) {
                    const geometry = mesh.geometry.clone();
                    geometry.computeVertexNormals();
                    geometry.computeBoundingSphere();
                    this.assets[key] = geometry;
                    if (key === "foodCrystal") this.rebuildFoodInstances = true;
                    if (key === "boundaryTower") this.replaceBoundaryTowerGeometry(geometry);
                    if (key === "arenaModule") this.replaceArenaModuleGeometry(geometry);
                }
            } catch (error) {
                console.warn("Neon asset fallback:", key, error);
            }
        }));
    }

    replaceBoundaryTowerGeometry(geometry) {
        if (!this.boundaryTowers) return;
        for (const tower of this.boundaryTowers) {
            tower.geometry = geometry;
            tower.scale.set(42, 72, 42);
        }
    }

    replaceArenaModuleGeometry(geometry) {
        if (!this.arenaModules) return;
        for (const module of this.arenaModules) {
            module.geometry = geometry;
            module.scale.set(140, 36, 140);
        }
    }

    getCellMaterial(cell) {
        const color = colorFromNumber(cell.color, 0x22d3ee);
        const key = `${color}:${cell.local ? "local" : "other"}:${cell.threat ? "threat" : "safe"}`;
        if (this.materialCache.has(key)) return this.materialCache.get(key);
        const base = new THREE.Color(color);
        const emissive = new THREE.Color(cell.threat ? 0xfb7185 : color);
        const material = new THREE.MeshStandardMaterial({
            color: base,
            emissive,
            emissiveIntensity: cell.local ? 1.25 : cell.threat ? 0.8 : 0.35,
            roughness: cell.local ? 0.2 : 0.38,
            metalness: 0.08
        });
        this.materialCache.set(key, material);
        return material;
    }

    setQuality(quality) {
        this.qualityName = QUALITY[quality] ? quality : "high";
        this.quality = QUALITY[this.qualityName];
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
        this.bloomPass.strength = this.quality.bloomStrength;
        this.bloomPass.radius = this.quality.bloomRadius;
        this.bloomPass.threshold = this.quality.bloomThreshold;
        this.resize(window.innerWidth, window.innerHeight);
    }

    resetCamera() {
        this.cameraTheta = 0;
        this.cameraPhi = Math.PI * 0.36;
        this.cameraZoomBias = 1;
    }

    render(snapshot, time = 0, dt = 0.016) {
        if (this.disposed || this.contextLost || !snapshot) return;
        this.now = time;
        if (snapshot.worldSize && snapshot.worldSize !== this.worldSize) {
            this.worldSize = snapshot.worldSize;
        }
        this.updateCamera(snapshot.localPlayer, dt);
        this.syncCells(snapshot);
        this.syncFood(snapshot.food);
        this.syncViruses(snapshot.viruses);
        this.syncPowerups(snapshot.powerups);
        this.syncHotspots(snapshot.hotspots, snapshot.bounties);
        this.syncEffects(snapshot.effects, snapshot);
        this.syncLocalGuides(snapshot);
        if (this.quality.composer) this.composer.render();
        else this.renderer.render(this.scene, this.camera);
    }

    updateCamera(localPlayer, dt) {
        if (!localPlayer || !localPlayer.mass) return;
        const target = new THREE.Vector3(localPlayer.x, 0, localPlayer.y);
        this.cameraTarget.lerp(target, 1 - Math.exp(-5.8 * dt));
        const desiredDistance = THREE.MathUtils.clamp(760 + Math.sqrt(localPlayer.mass) * 13, 850, 5200) * this.cameraZoomBias;
        this.cameraDistance += (desiredDistance - this.cameraDistance) * (1 - Math.exp(-3.8 * dt));
        const sinPhi = Math.sin(this.cameraPhi);
        this.camera.position.set(
            this.cameraTarget.x + this.cameraDistance * sinPhi * Math.sin(this.cameraTheta),
            120 + this.cameraDistance * Math.cos(this.cameraPhi),
            this.cameraTarget.z + this.cameraDistance * sinPhi * Math.cos(this.cameraTheta)
        );
        this.camera.lookAt(this.cameraTarget.x, Math.min(260, Math.sqrt(localPlayer.mass) * 4), this.cameraTarget.z);
    }

    syncCells(snapshot) {
        const seen = new Set();
        for (const cell of snapshot.cells) {
            seen.add(cell.id);
            let bundle = this.cellMeshes.get(cell.id);
            if (!bundle) {
                const mesh = new THREE.Mesh(this.geometries.unitSphere, this.getCellMaterial(cell));
                const outline = new THREE.Mesh(this.geometries.unitSphereLow, this.materials.localOutline);
                const core = new THREE.Mesh(this.assets.playerCore || this.geometries.food, new THREE.MeshBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.68, wireframe: true }));
                outline.visible = !!cell.local;
                core.visible = !!cell.local;
                mesh.add(outline);
                mesh.add(core);
                this.scene.add(mesh);
                bundle = { mesh, outline, core };
                this.cellMeshes.set(cell.id, bundle);
            }
            const radius = cell.radius || radiusFromMass(cell.mass);
            bundle.mesh.material = this.getCellMaterial(cell);
            bundle.mesh.position.set(cell.x, radius + 3, cell.y);
            bundle.mesh.scale.setScalar(radius);
            bundle.mesh.visible = true;
            bundle.outline.visible = !!cell.local;
            bundle.outline.scale.setScalar(1.075 + Math.sin(this.now * 0.006) * 0.018);
            bundle.core.visible = !!cell.local;
            bundle.core.rotation.y = this.now * 0.0018;
            bundle.core.rotation.x = this.now * 0.0011;
            bundle.core.scale.setScalar(0.58);
            this.syncTrail(cell);
        }
        for (const [id, bundle] of this.cellMeshes) {
            if (!seen.has(id)) {
                this.scene.remove(bundle.mesh);
                this.cellMeshes.delete(id);
            }
        }
        for (const [id, line] of this.trailLines) {
            if (!seen.has(id)) {
                this.scene.remove(line);
                line.geometry.dispose();
                this.trailLines.delete(id);
            }
        }
    }

    syncTrail(cell) {
        if (!cell.trail || cell.trail.length < 2) return;
        const points = cell.trail.slice(-this.quality.trailLimit).map(point => new THREE.Vector3(point.x, 5, point.y));
        let line = this.trailLines.get(cell.id);
        if (!line) {
            line = new THREE.Line(new THREE.BufferGeometry(), cell.threat ? this.materials.threatTrail : this.materials.trail);
            this.scene.add(line);
            this.trailLines.set(cell.id, line);
        }
        line.material = cell.threat ? this.materials.threatTrail : this.materials.trail;
        line.geometry.dispose();
        line.geometry = new THREE.BufferGeometry().setFromPoints(points);
        line.visible = true;
    }

    syncFood(food) {
        const count = Math.min(food.length, this.quality.foodLimit);
        if (!this.foodInstance || this.foodCapacity < count || this.rebuildFoodInstances) {
            if (this.foodInstance) {
                this.scene.remove(this.foodInstance);
                this.foodInstance.geometry.dispose();
                this.foodInstance.material.dispose();
            }
            this.foodCapacity = Math.max(128, count);
            const material = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xfacc15,
                emissiveIntensity: 0.75,
                roughness: 0.28,
                metalness: 0.08,
                vertexColors: true
            });
            this.foodInstance = new THREE.InstancedMesh(this.assets.foodCrystal || this.geometries.food, material, this.foodCapacity);
            this.foodInstance.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.foodCapacity * 3), 3);
            this.scene.add(this.foodInstance);
            this.rebuildFoodInstances = false;
        }
        this.foodInstance.visible = count > 0;
        for (let i = 0; i < this.foodCapacity; i++) {
            if (i < count) {
                const pellet = food[i];
                const radius = (pellet.radius || Math.sqrt(Math.max(1, pellet.mass || 2)) * 2.8) * (pellet.golden ? 1.4 : 1);
                this.tmpObject.position.set(pellet.x, radius + 5 + Math.sin(this.now * 0.004 + i) * 3, pellet.y);
                this.tmpObject.rotation.set(this.now * 0.001 + i, this.now * 0.0017 + i * 0.2, 0);
                this.tmpObject.scale.setScalar(radius);
                this.tmpObject.updateMatrix();
                this.foodInstance.setMatrixAt(i, this.tmpObject.matrix);
                this.tmpColor.setHex(pellet.golden ? 0xfacc15 : colorFromNumber(pellet.color, 0x84cc16));
                this.foodInstance.setColorAt(i, this.tmpColor);
            } else {
                this.tmpObject.position.set(0, -10000, 0);
                this.tmpObject.scale.setScalar(0.001);
                this.tmpObject.updateMatrix();
                this.foodInstance.setMatrixAt(i, this.tmpObject.matrix);
            }
        }
        this.foodInstance.instanceMatrix.needsUpdate = true;
        if (this.foodInstance.instanceColor) this.foodInstance.instanceColor.needsUpdate = true;
    }

    syncViruses(viruses) {
        while (this.virusMeshes.length < viruses.length) {
            const mesh = new THREE.Mesh(this.assets.virusSpike || this.geometries.virus, new THREE.MeshStandardMaterial({
                color: 0x22c55e,
                emissive: 0x22c55e,
                emissiveIntensity: 0.85,
                roughness: 0.44,
                metalness: 0.02,
                flatShading: true
            }));
            this.scene.add(mesh);
            this.virusMeshes.push(mesh);
        }
        for (let i = 0; i < this.virusMeshes.length; i++) {
            const mesh = this.virusMeshes[i];
            if (i >= viruses.length) {
                mesh.visible = false;
                continue;
            }
            const virus = viruses[i];
            const radius = virus.radius || 40;
            mesh.visible = true;
            mesh.position.set(virus.x, radius * 0.85 + 4, virus.y);
            mesh.scale.setScalar(radius);
            mesh.rotation.y = this.now * 0.001 + i;
        }
    }

    syncPowerups(powerups) {
        const seen = new Set();
        for (const powerup of powerups) {
            const key = `${powerup.type}:${Math.round(powerup.x)}:${Math.round(powerup.y)}`;
            seen.add(key);
            let group = this.powerupMeshes.get(key);
            if (!group) {
                group = new THREE.Group();
                const color = powerup.type === "shield" ? 0xfacc15 : powerup.type === "speed" ? 0x22c55e : 0x22d3ee;
                const ring = new THREE.Mesh(this.geometries.powerRing, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82 }));
                const core = new THREE.Mesh(this.assets.powerupCore || this.geometries.powerCore, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.75, roughness: 0.28 }));
                group.add(ring, core);
                this.scene.add(group);
                this.powerupMeshes.set(key, group);
            }
            const bob = Math.sin(this.now * 0.003 + powerup.x * 0.01) * 9;
            group.position.set(powerup.x, 42 + bob, powerup.y);
            group.rotation.y = this.now * 0.002;
            group.scale.setScalar(powerup.type === "shield" ? 1.25 : 1);
        }
        for (const [key, group] of this.powerupMeshes) {
            if (!seen.has(key)) {
                this.scene.remove(group);
                disposeObject(group);
                this.powerupMeshes.delete(key);
            }
        }
    }

    syncHotspots(hotspots, bounties) {
        const seen = new Set();
        for (const hotspot of hotspots) {
            const key = `hot:${hotspot.id || `${Math.round(hotspot.x)}:${Math.round(hotspot.y)}`}`;
            seen.add(key);
            let mesh = this.hotspotMeshes.get(key);
            if (!mesh) {
                mesh = new THREE.Mesh(new THREE.RingGeometry(0.74, 1, 96), this.materials.hotspot.clone());
                mesh.rotation.x = -Math.PI / 2;
                this.scene.add(mesh);
                this.hotspotMeshes.set(key, mesh);
            }
            const radius = hotspot.radius || 260;
            mesh.position.set(hotspot.x, 8, hotspot.y);
            mesh.scale.setScalar(radius);
            mesh.material.opacity = 0.12 + Math.sin(this.now * 0.003 + radius) * 0.035;
        }
        for (const bounty of bounties) {
            if (!bounty || bounty.completed) continue;
            const target = bounty.target || bounty.targetPoint || null;
            if (!target) continue;
            const key = `bounty:${bounty.id}`;
            seen.add(key);
            let mesh = this.hotspotMeshes.get(key);
            if (!mesh) {
                mesh = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 96), this.materials.bounty.clone());
                mesh.rotation.x = -Math.PI / 2;
                this.scene.add(mesh);
                this.hotspotMeshes.set(key, mesh);
            }
            mesh.position.set(target.x, 12, target.y);
            mesh.scale.setScalar(target.radius || 180);
        }
        for (const [key, mesh] of this.hotspotMeshes) {
            if (!seen.has(key)) {
                this.scene.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
                this.hotspotMeshes.delete(key);
            }
        }
    }

    syncEffects(effects, snapshot) {
        const effectCount = Math.min(effects.length, Math.ceil(18 * this.quality.particleScale));
        while (this.effectMeshes.length < effectCount + 3) {
            const mesh = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 72), this.materials.shockwave.clone());
            mesh.rotation.x = -Math.PI / 2;
            this.scene.add(mesh);
            this.effectMeshes.push(mesh);
        }
        for (let i = 0; i < this.effectMeshes.length; i++) {
            const mesh = this.effectMeshes[i];
            if (i < effectCount) {
                const effect = effects[i];
                const ageRatio = effect.life ? THREE.MathUtils.clamp(effect.age / effect.life, 0, 1) : 0.5;
                const radius = (effect.radius || 42) * (1 + ageRatio * 1.8);
                mesh.visible = true;
                mesh.position.set(effect.x, 16 + i * 0.03, effect.y);
                mesh.scale.setScalar(radius);
                mesh.material.color.setHex(colorFromNumber(effect.color, 0xffffff));
                mesh.material.opacity = (1 - ageRatio) * 0.52;
            } else if (i === effectCount && snapshot.gravityActive) {
                this.updateGlobalPulse(mesh, 0x818cf8, 0.2);
            } else if (i === effectCount + 1 && snapshot.antigravityActive) {
                this.updateGlobalPulse(mesh, 0x67e8f9, 0.2);
            } else {
                mesh.visible = false;
            }
        }
    }

    updateGlobalPulse(mesh, color, opacity) {
        mesh.visible = true;
        mesh.position.set(this.cameraTarget.x, 10, this.cameraTarget.z);
        mesh.scale.setScalar(520 + Math.sin(this.now * 0.004) * 60);
        mesh.material.color.setHex(color);
        mesh.material.opacity = opacity;
    }

    syncLocalGuides(snapshot) {
        const local = snapshot.localPlayer;
        if (!local || !local.mass) {
            this.localRing.visible = false;
            this.localBeacon.visible = false;
            this.localArrow.visible = false;
            return;
        }
        const radius = radiusFromMass(local.mass);
        const pulse = 1 + Math.sin(this.now * 0.006) * 0.05;
        this.localRing.visible = true;
        this.localRing.position.set(local.x, 9, local.y);
        this.localRing.scale.setScalar((radius + 32) * pulse);
        this.localRing.material.color.setHex(snapshot.comboActive ? 0xfacc15 : 0x22d3ee);

        this.localBeacon.visible = true;
        this.localBeacon.position.set(local.x, 520, local.y);
        this.localBeacon.scale.set(radius * 0.04, 920, radius * 0.04);
        this.localBeacon.material.opacity = 0.22 + Math.sin(this.now * 0.005) * 0.08;

        this.localArrow.visible = true;
        this.localArrow.position.set(local.x, radius * 2.2 + 120, local.y);
        this.localArrow.rotation.y = this.now * 0.003;
    }

    resize(width, height) {
        if (this.disposed) return;
        this.camera.aspect = width / Math.max(1, height);
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
        this.renderer.setSize(width, height);
        this.composer.setSize(width, height);
    }

    show() {
        this.mount.style.display = "block";
    }

    hide() {
        this.mount.style.display = "none";
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        const canvas = this.renderer?.domElement;
        if (canvas) {
            canvas.removeEventListener("contextmenu", this._onContextMenu);
            canvas.removeEventListener("pointerdown", this._onPointerDown);
            canvas.removeEventListener("wheel", this._onWheel);
            canvas.removeEventListener("webglcontextlost", this._onContextLost);
            canvas.removeEventListener("webglcontextrestored", this._onContextRestored);
        }
        window.removeEventListener("pointermove", this._onPointerMove);
        window.removeEventListener("pointerup", this._onPointerUp);
        window.removeEventListener("resize", this._onResize);
        this.resetButton?.remove();
        for (const [, bundle] of this.cellMeshes) this.scene.remove(bundle.mesh);
        for (const [, group] of this.powerupMeshes) {
            this.scene.remove(group);
            disposeObject(group);
        }
        for (const [, mesh] of this.hotspotMeshes) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        for (const [, line] of this.trailLines) {
            this.scene.remove(line);
            line.geometry.dispose();
        }
        for (const mesh of this.virusMeshes) this.scene.remove(mesh);
        for (const mesh of this.boundaryTowers || []) {
            this.scene.remove(mesh);
            disposeObject(mesh);
        }
        for (const mesh of this.arenaModules || []) {
            this.scene.remove(mesh);
            disposeObject(mesh);
        }
        for (const mesh of this.effectMeshes) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        if (this.foodInstance) {
            this.scene.remove(this.foodInstance);
            this.foodInstance.geometry.dispose();
            this.foodInstance.material.dispose();
        }
        this.materialCache.forEach(material => material.dispose());
        Object.values(this.materials).forEach(material => material.dispose());
        Object.values(this.geometries).forEach(geometry => geometry.dispose());
        this.composer?.dispose?.();
        this.renderer.dispose();
        this.mount.classList.remove("neon-three-active");
        this.mount.style.display = "none";
        this.mount.innerHTML = "";
    }
}
