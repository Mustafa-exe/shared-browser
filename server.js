import express from "express";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 5500);

app.use(express.static(__dirname));

const server = app.listen(port, () => {
  console.log(`Shared Browser running at http://localhost:${port}`);
});

const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();

wss.on("connection", (ws) => {
  let roomId = "";
  let clientId = "";

  ws.on("message", (raw) => {
    const msg = parseMessage(raw);
    if (!msg) return;

    if (msg.type === "join") {
      if (roomId && clientId) {
        removeClient(roomId, clientId);
      }

      const nextRoomId = sanitizeRoom(msg.roomId);
      const nextClientId = sanitizeId(msg.clientId);
      const name = sanitizeName(msg.name || "guest");
      const desiredRole = msg.role === "host" ? "host" : "viewer";

      if (!nextRoomId || !nextClientId) {
        safeSend(ws, { type: "error", message: "Invalid room or client id." });
        return;
      }

      const room = getOrCreateRoom(nextRoomId);

      if (desiredRole === "host" && room.hostId && room.hostId !== nextClientId) {
        safeSend(ws, { type: "error", message: "Room already has a host." });
        return;
      }

      roomId = nextRoomId;
      clientId = nextClientId;

      if (desiredRole === "host") {
        room.hostId = nextClientId;
      }

      room.clients.set(nextClientId, {
        ws,
        id: nextClientId,
        name,
        role: desiredRole
      });

      safeSend(ws, {
        type: "joined",
        roomId,
        role: desiredRole,
        hostId: room.hostId || ""
      });

      broadcastSystem(roomId, `${name} joined as ${desiredRole}`);
      broadcastPresence(roomId);

      if (room.streamLive && room.hostId) {
        safeSend(ws, {
          type: "stream-status",
          live: true,
          fromId: room.hostId
        });
      }
      return;
    }

    if (!roomId || !clientId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const sender = room.clients.get(clientId);
    if (!sender) return;

    if (msg.type === "leave") {
      removeClient(roomId, clientId);
      roomId = "";
      clientId = "";
      return;
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "").trim().slice(0, 400);
      if (!text) return;

      broadcast(roomId, {
        type: "chat",
        fromId: sender.id,
        name: sender.name,
        text,
        ts: Date.now(),
        system: false
      });
      return;
    }

    if (msg.type === "control-request") {
      if (sender.role !== "viewer") return;
      if (!room.hostId) return;

      const host = room.clients.get(room.hostId);
      if (!host) return;

      safeSend(host.ws, {
        type: "control-request",
        fromId: sender.id,
        name: sender.name,
        ts: Date.now()
      });
      return;
    }

    if (msg.type === "control-response") {
      if (sender.role !== "host" || room.hostId !== sender.id) return;

      const targetId = sanitizeId(msg.targetId);
      if (!targetId) return;

      const target = room.clients.get(targetId);
      if (!target || target.role !== "viewer") return;

      if (!msg.granted) {
        safeSend(target.ws, {
          type: "control-denied",
          viewerId: target.id,
          viewerName: target.name,
          byId: sender.id,
          byName: sender.name,
          ts: Date.now()
        });
        return;
      }

      room.controlViewerId = target.id;

      broadcast(roomId, {
        type: "control-status",
        granted: true,
        viewerId: target.id,
        viewerName: target.name,
        byId: sender.id,
        byName: sender.name,
        ts: Date.now()
      });

      broadcastPresence(roomId);
      return;
    }

    if (msg.type === "control-revoke") {
      if (sender.role !== "host" || room.hostId !== sender.id) return;
      if (!room.controlViewerId) return;

      const releasedId = room.controlViewerId;
      const releasedName = room.clients.get(releasedId)?.name || "viewer";
      room.controlViewerId = "";

      broadcast(roomId, {
        type: "control-status",
        granted: false,
        viewerId: releasedId,
        viewerName: releasedName,
        byId: sender.id,
        byName: sender.name,
        ts: Date.now()
      });

      broadcastPresence(roomId);
      return;
    }

    if (msg.type === "control-release") {
      if (sender.role !== "viewer") return;
      if (room.controlViewerId !== sender.id) return;

      room.controlViewerId = "";

      broadcast(roomId, {
        type: "control-status",
        granted: false,
        viewerId: sender.id,
        viewerName: sender.name,
        byId: sender.id,
        byName: sender.name,
        ts: Date.now()
      });

      broadcastPresence(roomId);
      return;
    }

    if (msg.type === "control-input") {
      if (sender.role !== "viewer") return;
      if (room.controlViewerId !== sender.id) return;

      const input = sanitizeControlInput(msg.input);
      if (!input) return;

      broadcast(roomId, {
        type: "control-input",
        fromId: sender.id,
        name: sender.name,
        input,
        ts: Date.now()
      });
      return;
    }

    if (msg.type === "signal") {
      const targetId = sanitizeId(msg.targetId);
      if (!targetId) return;

      const target = room.clients.get(targetId);
      if (!target) return;

      const signal = msg.signal && typeof msg.signal === "object" ? msg.signal : null;
      if (!signal) return;

      safeSend(target.ws, {
        type: "signal",
        fromId: sender.id,
        signal
      });
      return;
    }

    if (msg.type === "stream-status") {
      if (sender.role !== "host" || room.hostId !== sender.id) return;

      room.streamLive = Boolean(msg.live);
      broadcast(roomId, {
        type: "stream-status",
        live: room.streamLive,
        fromId: sender.id
      });
      broadcastPresence(roomId);
    }
  });

  ws.on("close", () => {
    if (!roomId || !clientId) return;
    removeClient(roomId, clientId);
    roomId = "";
    clientId = "";
  });
});

function getOrCreateRoom(roomId) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const room = {
    id: roomId,
    hostId: "",
    controlViewerId: "",
    streamLive: false,
    clients: new Map()
  };
  rooms.set(roomId, room);
  return room;
}

function removeClient(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const client = room.clients.get(clientId);
  room.clients.delete(clientId);

  if (room.controlViewerId === clientId) {
    room.controlViewerId = "";
    broadcast(roomId, {
      type: "control-status",
      granted: false,
      viewerId: clientId,
      viewerName: client?.name || "viewer",
      byId: clientId,
      byName: client?.name || "viewer",
      ts: Date.now()
    });
  }

  if (room.hostId === clientId) {
    room.controlViewerId = "";
    room.hostId = "";
    room.streamLive = false;
    broadcast(roomId, {
      type: "stream-status",
      live: false,
      fromId: clientId
    });
    broadcastSystem(roomId, "Host left. Screen share stopped.");
  } else if (client) {
    broadcastSystem(roomId, `${client.name} left`);
  }

  broadcastPresence(roomId);

  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const participants = [];
  for (const [id, client] of room.clients.entries()) {
    participants.push({
      id,
      name: client.name,
      role: client.role
    });
  }

  const viewerCount = participants.filter((p) => p.role === "viewer").length;
  const controlViewerId = room.controlViewerId || "";
  const controlViewerName = controlViewerId ? room.clients.get(controlViewerId)?.name || "" : "";

  broadcast(roomId, {
    type: "presence",
    roomId,
    hostId: room.hostId || "",
    controlViewerId,
    controlViewerName,
    streamLive: room.streamLive,
    participants,
    viewerCount,
    onlineCount: participants.length
  });
}

function broadcastSystem(roomId, text) {
  broadcast(roomId, {
    type: "chat",
    fromId: "system",
    name: "system",
    text,
    ts: Date.now(),
    system: true
  });
}

function broadcast(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const client of room.clients.values()) {
    safeSend(client.ws, payload);
  }
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function sanitizeRoom(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 24);
}

function sanitizeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 36);
}

function sanitizeName(value) {
  return (
    String(value || "guest")
      .trim()
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .slice(0, 24) || "guest"
  );
}

function sanitizeControlInput(value) {
  if (!value || typeof value !== "object") return null;

  if (value.kind === "key") {
    const key = String(value.key || "").trim().slice(0, 64);
    if (!key) return null;
    return {
      kind: "key",
      key
    };
  }

  const kind = value.kind === "move" || value.kind === "click" ? value.kind : "";
  if (!kind) return null;

  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    kind,
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y))
  };
}
