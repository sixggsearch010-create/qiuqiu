import { Document, NodeIO } from "@gltf-transform/core";
import { dedup, prune } from "@gltf-transform/functions";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT_DIR = new URL("../public/assets/neon/", import.meta.url);

function createDocument(name, positions, indices, materialOptions) {
    const document = new Document();
    document.createBuffer();
    const scene = document.createScene("Scene");
    document.getRoot().setDefaultScene(scene);

    const material = document.createMaterial(name + "_mat")
        .setBaseColorFactor(materialOptions.baseColor)
        .setEmissiveFactor(materialOptions.emissive)
        .setRoughnessFactor(materialOptions.roughness ?? 0.48)
        .setMetallicFactor(materialOptions.metallic ?? 0.08);

    const primitive = document.createPrimitive()
        .setAttribute("POSITION", document.createAccessor("POSITION")
            .setType("VEC3")
            .setArray(new Float32Array(positions)))
        .setIndices(document.createAccessor("indices")
            .setType("SCALAR")
            .setArray(new Uint16Array(indices)))
        .setMaterial(material);

    const mesh = document.createMesh(name).addPrimitive(primitive);
    scene.addChild(document.createNode(name).setMesh(mesh));
    return document;
}

function octahedron(size = 1) {
    const s = size;
    return {
        positions: [
            0, s, 0, s, 0, 0, 0, 0, s, -s, 0, 0, 0, 0, -s, 0, -s, 0
        ],
        indices: [
            0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1,
            5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4
        ]
    };
}

function spike(radius = 1, height = 1.35, segments = 12) {
    const positions = [0, height, 0, 0, -height * 0.55, 0];
    for (let i = 0; i < segments; i++) {
        const a = (Math.PI * 2 * i) / segments;
        const r = radius * (i % 2 ? 0.62 : 1);
        positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
    const indices = [];
    for (let i = 0; i < segments; i++) {
        const a = 2 + i;
        const b = 2 + ((i + 1) % segments);
        indices.push(0, a, b, 1, b, a);
    }
    return { positions, indices };
}

function tower(width = 1, height = 3) {
    const w = width;
    const h = height;
    const positions = [
        -w, 0, -w, w, 0, -w, w, 0, w, -w, 0, w,
        -w * 0.45, h, -w * 0.45, w * 0.45, h, -w * 0.45, w * 0.45, h, w * 0.45, -w * 0.45, h, w * 0.45
    ];
    const indices = [
        0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        4, 5, 6, 4, 6, 7, 0, 3, 2, 0, 2, 1
    ];
    return { positions, indices };
}

function arenaModule(width = 1.2, height = 0.22) {
    const w = width;
    const h = height;
    const positions = [
        -w, 0, -w, w, 0, -w, w, 0, w, -w, 0, w,
        -w * 0.82, h, -w * 0.82, w * 0.82, h, -w * 0.82, w * 0.82, h, w * 0.82, -w * 0.82, h, w * 0.82
    ];
    const indices = [
        0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
        4, 5, 6, 4, 6, 7, 0, 3, 2, 0, 2, 1
    ];
    return { positions, indices };
}

async function writeAsset(fileName, shape, material) {
    const io = new NodeIO();
    const document = createDocument(fileName.replace(".glb", ""), shape.positions, shape.indices, material);
    await document.transform(dedup(), prune());
    await io.write(fileURLToPath(new URL(fileName, OUT_DIR)), document);
}

await mkdir(OUT_DIR, { recursive: true });

await writeAsset("player_core.glb", octahedron(1), {
    baseColor: [0.2, 0.9, 1, 1],
    emissive: [0.08, 0.8, 1],
    roughness: 0.32,
    metallic: 0.12
});
await writeAsset("food_crystal.glb", octahedron(1), {
    baseColor: [1, 0.82, 0.18, 1],
    emissive: [0.9, 0.42, 0.05],
    roughness: 0.2,
    metallic: 0.1
});
await writeAsset("virus_spike.glb", spike(1, 1.28, 14), {
    baseColor: [0.18, 1, 0.55, 1],
    emissive: [0.02, 0.55, 0.18],
    roughness: 0.55,
    metallic: 0.02
});
await writeAsset("boundary_tower.glb", tower(0.55, 3.4), {
    baseColor: [1, 0.18, 0.42, 1],
    emissive: [0.8, 0.04, 0.2],
    roughness: 0.38,
    metallic: 0.25
});
await writeAsset("powerup_core.glb", octahedron(1), {
    baseColor: [0.36, 1, 0.68, 1],
    emissive: [0.1, 0.9, 0.35],
    roughness: 0.24,
    metallic: 0.12
});
await writeAsset("arena_module.glb", arenaModule(1.2, 0.22), {
    baseColor: [0.14, 0.25, 0.58, 1],
    emissive: [0.04, 0.18, 0.75],
    roughness: 0.46,
    metallic: 0.18
});

console.log("Generated neon GLB assets in public/assets/neon");
