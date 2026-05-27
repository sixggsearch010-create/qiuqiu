// 小球吞噬战 - 局域网联机中继服务器
// 安装依赖: npm install ws
// 启动: node server.js [端口号]

const WebSocket = require("ws");
const os = require("os");

const PORT = parseInt(process.argv[2], 10) || 8080;
const MAX_CLIENTS = 4;
const MAX_NAME_LENGTH = 12;
const DEFAULT_ROOM_SETTINGS = { difficulty: "normal", aiMode: "normal" };
const VALID_DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const VALID_AI_MODES = new Set(["light", "normal", "dense"]);

const wss = new WebSocket.Server({ port: PORT });

let hostWs = null;
const clients = new Map(); // ws -> { id, name, role, ready }
let nextClientId = 1;
let roomSettings = { ...DEFAULT_ROOM_SETTINGS };
let roomStarted = false;

function getLanIp() {
    const interfaces = os.networkInterfaces();
    let fallback = "127.0.0.1";
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family !== "IPv4" || iface.internal) continue;
            if (!iface.address.startsWith("169.254.")) fallback = iface.address;
            if (
                iface.address.startsWith("192.168.") ||
                iface.address.startsWith("10.") ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(iface.address)
            ) {
                return iface.address;
            }
        }
    }
    return fallback;
}

function normalizeName(value, fallback) {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, MAX_NAME_LENGTH) : fallback;
}

function broadcast(data, excludeWs) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    for (const [ws] of clients) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

function sendTo(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(typeof data === "string" ? data : JSON.stringify(data));
    }
}

function normalizeSettings(value = {}) {
    return {
        difficulty: VALID_DIFFICULTIES.has(value.difficulty) ? value.difficulty : roomSettings.difficulty,
        aiMode: VALID_AI_MODES.has(value.aiMode) ? value.aiMode : roomSettings.aiMode
    };
}

function getPlayersList() {
    const list = [];
    for (const [, info] of clients) {
        list.push({ id: info.id, name: info.name, role: info.role, ready: info.role === "host" || !!info.ready });
    }
    return list;
}

function getRoomState() {
    return {
        type: "roomState",
        players: getPlayersList(),
        settings: { ...roomSettings },
        started: roomStarted
    };
}

function broadcastRoomState() {
    broadcast(getRoomState());
}

wss.on("connection", (ws) => {
    if (clients.size >= MAX_CLIENTS) {
        sendTo(ws, { type: "error", message: "房间已满 (最多4人)" });
        ws.close();
        return;
    }

    const clientId = nextClientId++;
    clients.set(ws, { id: clientId, name: "玩家" + clientId, role: "client", ready: false });

    console.log(`[连接] 客户端 #${clientId} 已连接 (当前 ${clients.size} 人)`);

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const info = clients.get(ws);
        if (!info) return;

        // 主机注册
        if (msg.type === "host") {
            if (hostWs && hostWs !== ws) {
                sendTo(ws, { type: "error", message: "已有主机存在" });
                ws.close();
                return;
            }
            hostWs = ws;
            info.role = "host";
            info.ready = true;
            info.name = normalizeName(msg.name, "主机");
            roomSettings = { ...DEFAULT_ROOM_SETTINGS };
            roomStarted = false;
            console.log(`[主机] 客户端 #${clientId} 成为主机`);
            sendTo(ws, {
                type: "hostRegistered",
                clientId,
                serverAddress: `${lanIp}:${PORT}`,
                players: getPlayersList(),
                settings: { ...roomSettings },
                started: roomStarted
            });
            broadcastRoomState();
            return;
        }

        // 客户端加入
        if (msg.type === "join") {
            if (!hostWs || hostWs.readyState !== WebSocket.OPEN) {
                sendTo(ws, { type: "error", message: "房间还没有主机，请先创建房间" });
                ws.close();
                return;
            }
            if (roomStarted) {
                sendTo(ws, { type: "error", message: "游戏已开始，暂不能加入" });
                ws.close();
                return;
            }
            info.name = normalizeName(msg.name, "玩家" + clientId);
            info.ready = false;
            console.log(`[加入] ${info.name} (#${clientId}) 加入房间`);
            sendTo(ws, {
                type: "welcome",
                clientId,
                players: getPlayersList(),
                settings: { ...roomSettings },
                started: roomStarted
            });
            broadcastRoomState();
            if (hostWs && hostWs !== ws) {
                sendTo(hostWs, { type: "playerJoined", clientId: info.id, name: info.name });
            }
            return;
        }

        if (msg.type === "ready") {
            if (ws === hostWs) return;
            if (roomStarted) {
                sendTo(ws, { type: "error", message: "游戏已开始，不能修改准备状态" });
                return;
            }
            info.ready = !!msg.ready;
            console.log(`[准备] ${info.name} (#${info.id}) ${info.ready ? "已准备" : "取消准备"}`);
            broadcastRoomState();
            return;
        }

        if (ws !== hostWs && (msg.type === "settings" || msg.type === "startGame")) {
            sendTo(ws, { type: "error", message: "只有房主可以修改设置或开始游戏" });
            return;
        }

        // 主机消息: 广播给所有客户端
        if (ws === hostWs) {
            if (msg.type === "settings") {
                if (roomStarted) {
                    sendTo(ws, { type: "error", message: "游戏已开始，不能修改房间设置" });
                    return;
                }
                roomSettings = normalizeSettings(msg.settings || msg);
                console.log(`[设置] 难度=${roomSettings.difficulty} AI=${roomSettings.aiMode}`);
                broadcastRoomState();
                return;
            }
            if (msg.type === "startGame") {
                const waitingPlayers = getPlayersList().filter(player => player.role !== "host" && !player.ready);
                if (waitingPlayers.length > 0) {
                    sendTo(ws, { type: "error", message: "还有玩家未准备，不能开始" });
                    return;
                }
                roomStarted = true;
                console.log("[开始] 主机开始游戏");
                broadcastRoomState();
                sendTo(ws, { type: "startGame", playerId: info.id, settings: { ...roomSettings }, host: true });
                for (const [clientWs, clientInfo] of clients) {
                    if (clientWs !== ws && clientWs.readyState === WebSocket.OPEN) {
                        sendTo(clientWs, { type: "startGame", playerId: clientInfo.id, settings: { ...roomSettings } });
                    }
                }
                return;
            }
            broadcast(msg, ws); // 广播给除主机外的所有人
            return;
        }

        // 客户端消息: 转发给主机
        if (hostWs) {
            msg._from = info.id;
            sendTo(hostWs, msg);
        }
    });

    ws.on("close", () => {
        const info = clients.get(ws);
        clients.delete(ws);
        if (info) {
            console.log(`[断开] ${info.name} (#${info.id}) 已断开 (剩余 ${clients.size} 人)`);
            if (ws === hostWs) {
                hostWs = null;
                roomStarted = false;
                roomSettings = { ...DEFAULT_ROOM_SETTINGS };
                broadcast({ type: "hostDisconnected" });
                console.log("[断开] 主机已断开，游戏结束");
            } else {
                broadcast({ type: "playerLeft", clientId: info.id });
                broadcastRoomState();
                if (hostWs) sendTo(hostWs, { type: "playerLeft", clientId: info.id });
            }
        }
    });
});

const lanIp = getLanIp();
console.log(`========================================`);
console.log(`  小球吞噬战 - 联机服务器`);
console.log(`  地址: ws://${lanIp}:${PORT}`);
console.log(`  本机: ws://localhost:${PORT}`);
console.log(`  等待玩家连接...`);
console.log(`========================================`);
