import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  remove,
  get,
  push,
  onValue,
  onChildAdded,
  onDisconnect,
  query,
  orderByChild,
  startAt
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const els = {
  connStatus: document.getElementById("connStatus"),
  roleLabel: document.getElementById("roleLabel"),
  roomLabel: document.getElementById("roomLabel"),
  roomInput: document.getElementById("roomInput"),
  nameInput: document.getElementById("nameInput"),
  hostBtn: document.getElementById("hostBtn"),
  joinBtn: document.getElementById("joinBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  shareModeSelect: document.getElementById("shareModeSelect"),
  startShareBtn: document.getElementById("startShareBtn"),
  stopShareBtn: document.getElementById("stopShareBtn"),
  streamState: document.getElementById("streamState"),
  requestControlBtn: document.getElementById("requestControlBtn"),
  releaseControlBtn: document.getElementById("releaseControlBtn"),
  revokeControlBtn: document.getElementById("revokeControlBtn"),
  controlState: document.getElementById("controlState"),
  hostViewerPanel: document.getElementById("hostViewerPanel"),
  viewerAccessList: document.getElementById("viewerAccessList"),
  localVideoCard: document.getElementById("localVideoCard"),
  remoteVideoCard: document.getElementById("remoteVideoCard"),
  fullscreenBtn: document.getElementById("fullscreenBtn"),
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  onlineCount: document.getElementById("onlineCount"),
  viewerCount: document.getElementById("viewerCount"),
  chatWrap: document.querySelector(".chat-wrap"),
  chatToggleBtn: document.getElementById("chatToggleBtn"),
  chatUnreadBadge: document.getElementById("chatUnreadBadge"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  controlPointer: document.getElementById("controlPointer"),
  controlPulse: document.getElementById("controlPulse"),
  toastStack: document.getElementById("toastStack")
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const clientId = createClientId();
const shareModeStorageKey = "shared_browser_share_mode";
let displayName = localStorage.getItem("shared_browser_name") || "guest";
let selectedShareMode = sanitizeShareMode(localStorage.getItem(shareModeStorageKey) || "window");
let realtimeReady = false;
let roomMetaRef = null;
let participantsRef = null;
let participantRef = null;
let eventsRef = null;
let joinedAtMs = 0;
let lastRealtimeError = "";
let latestParticipants = [];
let latestMeta = {
  hostId: "",
  streamLive: false,
  controlViewerId: ""
};
const roomUnsubscribers = [];
let roomId = "";
let role = "none";
let hostId = "";
let localStream = null;
let isRemoteFullscreen = false;
let isChatCollapsed = false;
let unreadMessages = 0;
let controlViewerId = "";
let controlViewerName = "";
let pendingControlRequest = false;
const pendingViewerRequests = new Set();
let lastControlMoveAt = 0;
let controlPointerTimer = null;
let controlCaptureBound = false;
let controlKeyboardBound = false;
let viewerParticipants = [];

const peers = new Map();
const participantNames = new Map();

bootstrap();

function bootstrap() {
  els.nameInput.value = displayName;
  els.shareModeSelect.value = selectedShareMode;

  // Live streams should always stay playing and should not expose pause controls.
  els.localVideo.controls = false;
  els.remoteVideo.controls = false;
  els.localVideo.addEventListener("pause", keepLiveVideoPlaying);
  els.remoteVideo.addEventListener("pause", keepLiveVideoPlaying);

  els.hostBtn.addEventListener("click", () => joinRoom("host"));
  els.joinBtn.addEventListener("click", () => joinRoom("viewer"));
  els.leaveBtn.addEventListener("click", () => leaveRoom());
  els.startShareBtn.addEventListener("click", () => startShare());
  els.stopShareBtn.addEventListener("click", () => stopShare());
  els.requestControlBtn.addEventListener("click", () => requestControlAccess());
  els.releaseControlBtn.addEventListener("click", () => releaseControlAccess());
  els.revokeControlBtn.addEventListener("click", () => revokeControlAccess());
  els.fullscreenBtn.addEventListener("click", () => toggleRemoteFullscreen());
  els.chatToggleBtn.addEventListener("click", () => {
    setChatCollapsed(!isChatCollapsed);
  });

  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChat();
  });

  els.nameInput.addEventListener("change", () => {
    displayName = sanitizeName(els.nameInput.value || "guest");
    els.nameInput.value = displayName;
    localStorage.setItem("shared_browser_name", displayName);
  });

  els.shareModeSelect.addEventListener("change", () => {
    selectedShareMode = sanitizeShareMode(els.shareModeSelect.value || "window");
    els.shareModeSelect.value = selectedShareMode;
    localStorage.setItem(shareModeStorageKey, selectedShareMode);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isRemoteFullscreen) {
      setRemoteFullscreen(false);
    }
  });

  setStatus("Connecting...", false);
  setRoleUi();
  setCounts(0, 0);
  setStreamState("Join a room to start.");
  updateUnreadBadge();
  updateControlUi();
  renderViewerAccessList();

  ensureSocket()
    .then(() => {
      if (!roomId) setStatus("Ready", true);
    })
    .catch((error) => {
      setStatus("Disconnected", false);
      const details = formatRealtimeError(error);
      renderLocalSystem(`Could not connect to Firebase realtime backend. ${details}`);
    });

  window.addEventListener("beforeunload", () => {
    // Firebase onDisconnect handlers clean up participant/meta state.
  });
}

async function joinRoom(nextRole) {
  const nextRoom = sanitizeRoom(els.roomInput.value);
  if (!nextRoom) {
    alert("Enter a valid room code.");
    return;
  }

  displayName = sanitizeName(els.nameInput.value || "guest");
  els.nameInput.value = displayName;
  localStorage.setItem("shared_browser_name", displayName);

  if (roomId) {
    await leaveRoom({ silent: true });
  }

  roomId = nextRoom;
  role = nextRole;
  setRoleUi();

  const joined = await joinRealtimeRoom();
  if (!joined) {
    setStatus("Disconnected", false);
    role = "none";
    roomId = "";
    hostId = "";
    setRoleUi();
    const reason = lastRealtimeError ? `\n\n${lastRealtimeError}` : "";
    alert(`Failed to join room.${reason}`);
  }
}

async function leaveRoom(options = {}) {
  const { silent = false } = options;

  if (roomId) {
    await leaveRealtimeRoom();
  }

  stopShare(false);
  clearAllPeers();
  clearRemoteVideo();
  setRemoteFullscreen(false);
  resetChatIndicators();
  clearPopups();
  resetControlState();

  roomId = "";
  role = "none";
  hostId = "";

  setRoleUi();
  setCounts(0, 0);

  if (realtimeReady) {
    setStatus("Ready", true);
  } else {
    setStatus("Disconnected", false);
  }

  setStreamState("Join a room to start.");

  if (!silent) {
    renderLocalSystem("Left room.");
  }
}

function ensureSocket() {
  if (realtimeReady) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const connectedRef = ref(db, ".info/connected");

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;

      try {
        unsubscribe();
      } catch {
        // no-op
      }

      clearTimeout(timeoutId);

      if (ok) {
        realtimeReady = true;
        if (!roomId) {
          setStatus("Ready", true);
        }
        resolve();
        return;
      }

      reject(error || new Error("Realtime connection failed"));
    };

    const timeoutId = window.setTimeout(() => {
      // Fallback probe: this often works even before .info/connected flips true.
      get(ref(db, ".info/serverTimeOffset"))
        .then(() => {
          finish(true);
        })
        .catch((probeError) => {
          finish(false, probeError || new Error("Realtime connection timeout"));
        });
    }, 14000);

    const unsubscribe = onValue(
      connectedRef,
      (snapshot) => {
        if (!snapshot.val()) return;
        finish(true);
      },
      (error) => {
        finish(false, error || new Error("Realtime connection failed"));
      }
    );
  });
}

function send(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (!roomId) {
    return false;
  }

  void sendRealtimeEvent(payload);
  return true;
}

function getRoomBasePath() {
  return roomId ? `rooms/${roomId}` : "";
}

function bindRoomRefs() {
  const base = getRoomBasePath();
  if (!base) return false;

  roomMetaRef = ref(db, `${base}/meta`);
  participantsRef = ref(db, `${base}/participants`);
  participantRef = ref(db, `${base}/participants/${clientId}`);
  eventsRef = ref(db, `${base}/events`);
  return true;
}

function clearRoomSubscriptions() {
  while (roomUnsubscribers.length) {
    const unsubscribe = roomUnsubscribers.pop();
    if (typeof unsubscribe !== "function") continue;
    try {
      unsubscribe();
    } catch {
      // no-op
    }
  }
}

function resetRealtimeRefs() {
  clearRoomSubscriptions();
  roomMetaRef = null;
  participantsRef = null;
  participantRef = null;
  eventsRef = null;
  latestParticipants = [];
  latestMeta = {
    hostId: "",
    streamLive: false,
    controlViewerId: ""
  };
}

async function joinRealtimeRoom() {
  if (!bindRoomRefs()) {
    lastRealtimeError = "Invalid room path.";
    return false;
  }

  try {
    lastRealtimeError = "";

    const metaSnapshot = await get(roomMetaRef);
    const meta = (metaSnapshot && metaSnapshot.val()) || {};
    const existingHostId = String(meta.hostId || "");

    if (role === "host" && existingHostId && existingHostId !== clientId) {
      renderLocalSystem("Room already has a host.");
      lastRealtimeError = "Room already has a host.";
      return false;
    }

    await set(participantRef, {
      id: clientId,
      name: displayName,
      role,
      joinedAt: Date.now()
    });

    onDisconnect(participantRef).remove();

    if (role === "host") {
      await update(roomMetaRef, {
        hostId: clientId,
        streamLive: false,
        controlViewerId: ""
      });

      onDisconnect(roomMetaRef).update({
        hostId: "",
        streamLive: false,
        controlViewerId: ""
      });
    }

    joinedAtMs = Date.now();
    subscribeRealtimeRoom();

    await handleSocketMessage({
      type: "joined",
      roomId,
      role,
      hostId: role === "host" ? clientId : existingHostId
    });

    await publishSystemMessage(`${displayName} joined as ${role}`);
    return true;
  } catch (error) {
    console.warn("joinRealtimeRoom failed", error);
    lastRealtimeError = formatRealtimeError(error);
    return false;
  }
}

async function leaveRealtimeRoom() {
  if (!roomId || !participantRef) {
    resetRealtimeRefs();
    return;
  }

  const previousRole = role;
  const previousControlViewerId = controlViewerId;
  const previousName = displayName;

  try {
    if (previousRole === "host" && roomMetaRef) {
      await update(roomMetaRef, {
        hostId: "",
        streamLive: false,
        controlViewerId: ""
      });
    } else if (previousRole === "viewer" && roomMetaRef && previousControlViewerId === clientId) {
      await update(roomMetaRef, {
        controlViewerId: ""
      });
    }

    await remove(participantRef);
    await publishSystemMessage(`${previousName} left`);
  } catch (error) {
    console.warn("leaveRealtimeRoom failed", error);
  } finally {
    resetRealtimeRefs();
  }
}

function subscribeRealtimeRoom() {
  clearRoomSubscriptions();

  if (!participantsRef || !roomMetaRef || !eventsRef) {
    return;
  }

  const participantsUnsub = onValue(participantsRef, (snapshot) => {
    latestParticipants = Object.values(snapshot.val() || {});
    emitPresenceSnapshot();
  });

  const metaUnsub = onValue(roomMetaRef, async (snapshot) => {
    latestMeta = snapshot.val() || {};
    emitPresenceSnapshot();

    // If controller left unexpectedly, host clears stale control lock.
    if (role === "host") {
      const activeControllerId = String(latestMeta.controlViewerId || "");
      if (!activeControllerId) return;

      const controllerExists = latestParticipants.some(
        (participant) => participant && participant.id === activeControllerId && participant.role === "viewer"
      );

      if (!controllerExists && roomMetaRef) {
        await update(roomMetaRef, { controlViewerId: "" });
      }
    }
  });

  const eventsQuery = query(eventsRef, orderByChild("ts"), startAt(joinedAtMs - 2000));
  const eventsUnsub = onChildAdded(eventsQuery, (snapshot) => {
    const event = snapshot.val();
    void handleRealtimeEvent(event);
  });

  roomUnsubscribers.push(participantsUnsub, metaUnsub, eventsUnsub);
}

function emitPresenceSnapshot() {
  const participants = Array.isArray(latestParticipants) ? latestParticipants : [];
  const sanitizedParticipants = participants
    .filter((participant) => participant && participant.id)
    .map((participant) => ({
      id: participant.id,
      name: participant.name || "guest",
      role: participant.role === "host" ? "host" : "viewer"
    }));

  const hostFromMeta = String(latestMeta?.hostId || "");
  const streamLive = Boolean(latestMeta?.streamLive);
  const controlViewerId = String(latestMeta?.controlViewerId || "");
  const controlViewerName = controlViewerId
    ? sanitizedParticipants.find((participant) => participant.id === controlViewerId)?.name || ""
    : "";
  const viewerCount = sanitizedParticipants.filter((participant) => participant.role === "viewer").length;

  void handleSocketMessage({
    type: "presence",
    roomId,
    hostId: hostFromMeta,
    streamLive,
    controlViewerId,
    controlViewerName,
    participants: sanitizedParticipants,
    viewerCount,
    onlineCount: sanitizedParticipants.length
  });
}

async function handleRealtimeEvent(event) {
  if (!event || typeof event !== "object") return;

  const eventTs = Number(event.ts || 0);
  if (eventTs && eventTs < joinedAtMs - 2000) {
    return;
  }

  if (event.targetId && event.targetId !== clientId) {
    return;
  }

  if (event.type === "signal") {
    await handleSocketMessage({
      type: "signal",
      fromId: event.fromId || "",
      signal: event.signal || null
    });
    return;
  }

  await handleSocketMessage(event);
}

async function publishSystemMessage(text) {
  if (!eventsRef || !text) return;

  await push(eventsRef, {
    type: "chat",
    fromId: "system",
    name: "system",
    text,
    ts: Date.now(),
    system: true
  });
}

async function sendRealtimeEvent(payload) {
  if (!eventsRef) return;

  try {
    if (payload.type === "chat") {
      await push(eventsRef, {
        type: "chat",
        fromId: clientId,
        name: displayName,
        text: String(payload.text || "").slice(0, 400),
        ts: Date.now(),
        system: false
      });
      return;
    }

    if (payload.type === "signal") {
      const targetId = String(payload.targetId || "").trim();
      if (!targetId || !payload.signal) return;

      await push(eventsRef, {
        type: "signal",
        fromId: clientId,
        targetId,
        signal: payload.signal,
        ts: Date.now()
      });
      return;
    }

    if (payload.type === "stream-status") {
      if (role !== "host" || !roomMetaRef) return;

      const live = Boolean(payload.live);
      await update(roomMetaRef, {
        streamLive: live
      });

      await push(eventsRef, {
        type: "stream-status",
        fromId: clientId,
        live,
        ts: Date.now()
      });
      return;
    }

    if (payload.type === "control-request") {
      if (role !== "viewer" || !hostId) return;

      await push(eventsRef, {
        type: "control-request",
        fromId: clientId,
        targetId: hostId,
        name: displayName,
        ts: Date.now()
      });
      return;
    }

    if (payload.type === "control-response") {
      if (role !== "host" || !roomMetaRef) return;

      const targetId = String(payload.targetId || "").trim();
      if (!targetId) return;

      const viewerName = participantNames.get(targetId) || "viewer";
      const granted = Boolean(payload.granted);

      if (granted) {
        await update(roomMetaRef, {
          controlViewerId: targetId
        });

        await push(eventsRef, {
          type: "control-status",
          granted: true,
          viewerId: targetId,
          viewerName,
          byId: clientId,
          byName: displayName,
          ts: Date.now()
        });
      } else {
        await push(eventsRef, {
          type: "control-denied",
          targetId,
          viewerId: targetId,
          viewerName,
          byId: clientId,
          byName: displayName,
          ts: Date.now()
        });
      }
      return;
    }

    if (payload.type === "control-revoke") {
      if (role !== "host" || !roomMetaRef || !controlViewerId) return;

      const releasedId = controlViewerId;
      const releasedName = participantNames.get(releasedId) || controlViewerName || "viewer";

      await update(roomMetaRef, {
        controlViewerId: ""
      });

      await push(eventsRef, {
        type: "control-status",
        granted: false,
        viewerId: releasedId,
        viewerName: releasedName,
        byId: clientId,
        byName: displayName,
        ts: Date.now()
      });
      return;
    }

    if (payload.type === "control-release") {
      if (role !== "viewer" || !roomMetaRef || controlViewerId !== clientId) return;

      await update(roomMetaRef, {
        controlViewerId: ""
      });

      await push(eventsRef, {
        type: "control-status",
        granted: false,
        viewerId: clientId,
        viewerName: displayName,
        byId: clientId,
        byName: displayName,
        ts: Date.now()
      });
      return;
    }

    if (payload.type === "control-input") {
      if (role !== "viewer" || controlViewerId !== clientId) return;

      await push(eventsRef, {
        type: "control-input",
        fromId: clientId,
        name: displayName,
        input: payload.input,
        ts: Date.now()
      });
    }
  } catch (error) {
    console.warn("sendRealtimeEvent failed", error);
  }
}

async function handleSocketMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "error") {
    renderLocalSystem(msg.message || "Server error.");
    alert(msg.message || "Server error.");

    if (!roomId) {
      role = "none";
      setRoleUi();
    }
    return;
  }

  if (msg.type === "joined") {
    roomId = sanitizeRoom(msg.roomId || roomId);
    role = msg.role === "host" ? "host" : "viewer";
    hostId = msg.hostId || "";

    setRoleUi();
    setStatus("Connected", true);

    if (role === "host") {
      setStreamState("Room ready. Click Start Screen Share.");
    } else {
      setStreamState("Joined as viewer. Waiting for host.");
    }

    renderLocalSystem(`Joined room ${roomId} as ${role}.`);
    return;
  }

  if (msg.type === "presence") {
    syncFromPresence(msg);
    return;
  }

  if (msg.type === "signal") {
    await handleSignal(msg.fromId, msg.signal);
    return;
  }

  if (msg.type === "stream-status") {
    if (role === "viewer") {
      if (msg.live) {
        setStreamState("Host is live. Waiting for stream...");
      } else {
        clearRemoteVideo();
        setStreamState("Host stopped sharing.");
      }
    }

    if (role === "host" && msg.fromId === clientId) {
      if (msg.live) {
        setStreamState("You are live. Viewers should see your screen.");
      } else {
        setStreamState("Screen share stopped.");
      }
    }
    return;
  }

  if (msg.type === "control-request") {
    handleControlRequest(msg);
    return;
  }

  if (msg.type === "control-status") {
    applyControlStatus(msg);
    return;
  }

  if (msg.type === "control-denied") {
    pendingControlRequest = false;
    renderLocalSystem("Host denied your control request.");
    updateControlUi();
    return;
  }

  if (msg.type === "control-input") {
    handleControlInput(msg);
    return;
  }

  if (msg.type === "chat") {
    renderMessage(
      msg.name || "user",
      msg.text || "",
      msg.ts || Date.now(),
      Boolean(msg.system),
      msg.fromId || ""
    );
    maybeNotifyIncomingMessage(msg);
  }
}

function syncFromPresence(payload) {
  const online = Number(payload.onlineCount || 0);
  const viewers = Number(payload.viewerCount || 0);
  setCounts(online, viewers);

  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  participantNames.clear();
  for (const participant of participants) {
    if (!participant || !participant.id) continue;
    participantNames.set(participant.id, participant.name || "viewer");
  }

  viewerParticipants = participants.filter((participant) => participant && participant.role === "viewer");
  for (const requestedId of Array.from(pendingViewerRequests)) {
    const stillInRoom = viewerParticipants.some((viewer) => viewer.id === requestedId);
    if (!stillInRoom) {
      pendingViewerRequests.delete(requestedId);
    }
  }

  hostId = payload.hostId || "";

  const nextControlViewerId = payload.controlViewerId || "";
  const nextControlViewerName =
    payload.controlViewerName || (nextControlViewerId ? participantNames.get(nextControlViewerId) || "viewer" : "");

  controlViewerId = nextControlViewerId;
  controlViewerName = nextControlViewerName;

  if (controlViewerId !== clientId) {
    pendingControlRequest = false;
  }

  updateControlUi();
  renderViewerAccessList();
  updateControlCaptureState();

  if (role === "host") {
    const viewerIds = new Set(
      participants
        .filter((p) => p && p.role === "viewer" && p.id !== clientId)
        .map((p) => p.id)
    );

    for (const peerId of Array.from(peers.keys())) {
      if (!viewerIds.has(peerId)) {
        clearPeer(peerId);
      }
    }

    for (const viewerId of viewerIds) {
      ensurePeer(viewerId, true);
      if (localStream) {
        const changed = attachLocalTracks(viewerId);
        if (changed) {
          void renegotiatePeer(viewerId);
        }
      }
    }
  }

  if (role === "viewer") {
    if (!hostId) {
      clearAllPeers();
      clearRemoteVideo();
      setStreamState("No host in room.");
      return;
    }

    for (const peerId of Array.from(peers.keys())) {
      if (peerId !== hostId) {
        clearPeer(peerId);
      }
    }

    ensurePeer(hostId, false);

    if (payload.streamLive) {
      setStreamState("Host is live. Waiting for stream...");
    } else {
      clearRemoteVideo();
      setStreamState("Host is not sharing yet.");
    }
  }
}

function ensurePeer(peerId, initiator) {
  if (!peerId) return null;

  const existing = peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection(rtcConfig);

  const peer = {
    pc,
    initiator,
    pendingCandidates: [],
    pendingRenegotiation: false,
    makingOffer: false,
    disconnectTimer: null
  };

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;

    send({
      type: "signal",
      targetId: peerId,
      signal: {
        type: "candidate",
        candidate: event.candidate
      }
    });
  });

  pc.addEventListener("track", (event) => {
    if (role !== "viewer") return;

    const stream = event.streams && event.streams[0] ? event.streams[0] : null;
    if (!stream) return;

    els.remoteVideo.srcObject = stream;
    // Keep autoplay reliable for incoming host stream; viewer can unmute via controls.
    els.remoteVideo.muted = true;
    const playPromise = els.remoteVideo.play?.();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        setStreamState("Stream received. Click play if autoplay is blocked.");
      });
    }

    setStreamState("Receiving host stream.");
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected" && peer.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = null;
    }

    if (pc.connectionState === "disconnected") {
      if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = setTimeout(() => {
        const latest = peers.get(peerId);
        if (!latest) return;
        if (latest.pc.connectionState === "disconnected") {
          clearPeer(peerId);
          if (role === "viewer") {
            clearRemoteVideo();
            setStreamState("Connection dropped. Waiting to reconnect...");
          }
        }
      }, 8000);
      return;
    }

    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      clearPeer(peerId);
    }
  });

  pc.addEventListener("signalingstatechange", () => {
    if (pc.signalingState === "stable" && peer.pendingRenegotiation && role === "host") {
      peer.pendingRenegotiation = false;
      void renegotiatePeer(peerId);
    }
  });

  peers.set(peerId, peer);

  if (initiator && role === "host" && localStream) {
    const changed = attachLocalTracks(peerId);
    if (changed) {
      void renegotiatePeer(peerId);
    }
  }

  return peer;
}

function clearPeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;

  if (peer.disconnectTimer) {
    clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
  }

  try {
    peer.pc.close();
  } catch {
    // no-op
  }

  peers.delete(peerId);
}

function clearAllPeers() {
  for (const peerId of Array.from(peers.keys())) {
    clearPeer(peerId);
  }
}

function attachLocalTracks(peerId) {
  const peer = peers.get(peerId);
  if (!peer || !localStream) return false;

  let changed = false;

  for (const track of localStream.getTracks()) {
    const alreadyAttached = peer.pc
      .getSenders()
      .some((sender) => sender.track && sender.track.id === track.id);

    if (!alreadyAttached) {
      peer.pc.addTrack(track, localStream);
      changed = true;
    }
  }

  return changed;
}

async function renegotiatePeer(peerId) {
  if (role !== "host" || !roomId) return;

  const peer = peers.get(peerId);
  if (!peer) return;

  if (peer.makingOffer) {
    peer.pendingRenegotiation = true;
    return;
  }

  if (peer.pc.signalingState !== "stable") {
    peer.pendingRenegotiation = true;
    return;
  }

  peer.makingOffer = true;

  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);

    send({
      type: "signal",
      targetId: peerId,
      signal: {
        type: "offer",
        offer: peer.pc.localDescription
      }
    });
  } catch (err) {
    console.warn("renegotiation failed", err);
  } finally {
    peer.makingOffer = false;

    if (peer.pendingRenegotiation && peer.pc.signalingState === "stable") {
      peer.pendingRenegotiation = false;
      setTimeout(() => {
        void renegotiatePeer(peerId);
      }, 0);
    }
  }
}

async function handleSignal(fromId, signal) {
  if (!fromId || !signal || typeof signal !== "object") return;

  if (role === "host" && signal.type === "offer") {
    return;
  }

  let peer = peers.get(fromId);
  if (!peer) {
    peer = ensurePeer(fromId, role === "host");
  }
  if (!peer) return;

  if (signal.type === "offer") {
    await handleOffer(peer, fromId, signal.offer);
    return;
  }

  if (signal.type === "answer") {
    await handleAnswer(peer, signal.answer);
    return;
  }

  if (signal.type === "candidate") {
    await handleCandidate(peer, signal.candidate);
  }
}

async function handleOffer(peer, fromId, offer) {
  if (!offer) return;

  try {
    if (peer.pc.signalingState !== "stable") {
      try {
        await peer.pc.setLocalDescription({ type: "rollback" });
      } catch {
        // ignore rollback failures
      }
    }

    await peer.pc.setRemoteDescription(offer);
    await flushBufferedCandidates(peer);

    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);

    send({
      type: "signal",
      targetId: fromId,
      signal: {
        type: "answer",
        answer: peer.pc.localDescription
      }
    });
  } catch (err) {
    console.warn("offer handling failed", err);
  }
}

async function handleAnswer(peer, answer) {
  if (!answer) return;

  try {
    await peer.pc.setRemoteDescription(answer);
    await flushBufferedCandidates(peer);
  } catch (err) {
    console.warn("answer handling failed", err);
  }
}

async function handleCandidate(peer, candidate) {
  if (!candidate) return;

  if (!peer.pc.remoteDescription) {
    peer.pendingCandidates.push(candidate);
    return;
  }

  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn("candidate handling failed", err);
  }
}

async function flushBufferedCandidates(peer) {
  if (!peer.pendingCandidates.length) return;

  const pending = [...peer.pendingCandidates];
  peer.pendingCandidates.length = 0;

  for (const candidate of pending) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch {
      // ignore individual candidate failures
    }
  }
}

async function startShare() {
  if (role !== "host") {
    alert("Only host can start screen share.");
    return;
  }

  if (!roomId) {
    alert("Join a room first.");
    return;
  }

  try {
    selectedShareMode = sanitizeShareMode(els.shareModeSelect.value || selectedShareMode);
    els.shareModeSelect.value = selectedShareMode;

    const stream = await getDisplayMediaCompat(selectedShareMode);
    localStream = stream;

    els.localVideo.srcObject = stream;
    els.localVideo.muted = true;
    setStreamState(`You are live (${shareModeLabel(selectedShareMode)}). Viewers should see your screen.`);

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.onended = () => {
        stopShare();
      };
    }

    send({ type: "stream-status", live: true });

    for (const peerId of Array.from(peers.keys())) {
      const changed = attachLocalTracks(peerId);
      if (changed) {
        void renegotiatePeer(peerId);
      }
    }
  } catch (err) {
    const message = typeof err?.message === "string" ? err.message : "Could not start screen share.";
    alert(message);
  }
}

async function getDisplayMediaCompat(mode) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen sharing is not supported in this browser.");
  }

  const options = buildShareConstraintOptions(sanitizeShareMode(mode));

  let lastError = null;

  for (const constraints of options) {
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      lastError = err;
      if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
        throw err;
      }
    }
  }

  throw lastError || new Error("Could not start screen share.");
}

function buildShareConstraintOptions(mode) {
  const frameRate = { frameRate: { ideal: 30, max: 60 } };

  if (mode === "window") {
    return [
      {
        video: {
          ...frameRate,
          displaySurface: "window"
        },
        audio: false,
        preferCurrentTab: false
      },
      {
        video: {
          ...frameRate
        },
        audio: false
      },
      {
        video: true,
        audio: false
      }
    ];
  }

  if (mode === "screen") {
    return [
      {
        video: {
          ...frameRate,
          displaySurface: "monitor"
        },
        audio: false
      },
      {
        video: {
          ...frameRate
        },
        audio: false
      },
      {
        video: true,
        audio: false
      }
    ];
  }

  return [
    {
      video: {
        ...frameRate
      },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include"
    },
    {
      video: {
        ...frameRate
      },
      audio: true
    },
    {
      video: true,
      audio: false
    }
  ];
}

function stopShare(notify = true) {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  els.localVideo.srcObject = null;

  if (role === "host") {
    if (notify && roomId) {
      send({ type: "stream-status", live: false });
    }

    for (const [peerId, peer] of peers.entries()) {
      let changed = false;
      for (const sender of peer.pc.getSenders()) {
        if (sender.track) {
          peer.pc.removeTrack(sender);
          changed = true;
        }
      }
      if (changed) {
        void renegotiatePeer(peerId);
      }
    }

    if (roomId) {
      setStreamState("Screen share stopped.");
    }
  }
}

function clearRemoteVideo() {
  els.remoteVideo.srcObject = null;
}

function sendChat() {
  if (!roomId) {
    alert("Join a room before chatting.");
    return;
  }

  const text = String(els.chatInput.value || "").trim();
  if (!text) return;

  const ok = send({
    type: "chat",
    text: text.slice(0, 400)
  });

  if (!ok) {
    alert("Chat failed. Realtime connection is unavailable.");
    return;
  }

  els.chatInput.value = "";
}

function renderMessage(name, text, ts, system = false, fromId = "") {
  const row = document.createElement("div");
  row.className = `msg${system ? " msg-system" : ""}`;
  if (!system && fromId === clientId) {
    row.classList.add("msg-own");
  }

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const time = new Date(ts || Date.now()).toLocaleTimeString();
  meta.textContent = `${name} - ${time}`;

  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text || "";

  row.append(meta, body);
  els.chatLog.appendChild(row);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderLocalSystem(text) {
  renderMessage("system", text, Date.now(), true);
}

function setStatus(text, connected) {
  els.connStatus.textContent = text;
  els.connStatus.classList.toggle("is-live", Boolean(connected));
  els.connStatus.classList.toggle("is-idle", !connected);
}

function setRoleUi() {
  els.roleLabel.textContent = role === "none" ? "No Role" : role.toUpperCase();
  els.roomLabel.textContent = roomId ? `Room: ${roomId}` : "Room: -";
  document.body.dataset.role = role;

  const canFullscreen = role !== "none";
  els.fullscreenBtn.disabled = !canFullscreen;

  if (!canFullscreen && isRemoteFullscreen) {
    setRemoteFullscreen(false);
  }

  updateControlUi();
  renderViewerAccessList();
  updateControlCaptureState();
}

function setCounts(online, viewers) {
  const onlineCount = Number.isFinite(Number(online)) ? Math.max(0, Number(online)) : 0;
  const viewerCount = Number.isFinite(Number(viewers)) ? Math.max(0, Number(viewers)) : 0;

  els.onlineCount.textContent = `${onlineCount} online`;
  els.viewerCount.textContent = `${viewerCount} viewers`;
}

function setStreamState(text) {
  els.streamState.textContent = text;
}

function toggleRemoteFullscreen() {
  if (role === "none") return;
  setRemoteFullscreen(!isRemoteFullscreen);
}

function setRemoteFullscreen(nextState) {
  isRemoteFullscreen = Boolean(nextState);
  document.body.classList.toggle("fullscreen-active", isRemoteFullscreen);
  els.remoteVideoCard.classList.toggle("is-fullscreen", isRemoteFullscreen);
  els.fullscreenBtn.textContent = isRemoteFullscreen ? "Exit Fullscreen" : "Fullscreen";
  els.chatToggleBtn.hidden = !isRemoteFullscreen;

  if (!isRemoteFullscreen) {
    setChatCollapsed(false);
  }

  syncOverlayState();
}

function setChatCollapsed(nextState) {
  isChatCollapsed = Boolean(nextState);
  els.chatWrap.classList.toggle("is-collapsed", isChatCollapsed);
  els.chatToggleBtn.textContent = isChatCollapsed ? "Open Chat" : "Minimize";
  els.chatToggleBtn.setAttribute("aria-expanded", String(!isChatCollapsed));

  if (!isChatCollapsed) {
    resetChatIndicators();
    clearPopups();
    if (isRemoteFullscreen) {
      const focusPromise = els.chatInput.focus({ preventScroll: true });
      if (focusPromise && typeof focusPromise.catch === "function") {
        focusPromise.catch(() => {});
      }
    }
  }

  syncOverlayState();
}

function syncOverlayState() {
  document.body.classList.toggle("chat-open", isRemoteFullscreen && !isChatCollapsed);
}

function maybeNotifyIncomingMessage(msg) {
  const fromId = String(msg?.fromId || "");
  if (!fromId || fromId === clientId || msg?.system) return;

  if (isRemoteFullscreen && isChatCollapsed) {
    unreadMessages += 1;
    updateUnreadBadge();
  }

  if (isRemoteFullscreen || document.visibilityState === "hidden") {
    showPopup(String(msg?.name || "Guest"), String(msg?.text || ""));
  }
}

function updateUnreadBadge() {
  if (!isRemoteFullscreen || !isChatCollapsed || unreadMessages <= 0) {
    els.chatUnreadBadge.hidden = true;
    els.chatUnreadBadge.textContent = "0";
    return;
  }

  const capped = unreadMessages > 99 ? "99+" : String(unreadMessages);
  els.chatUnreadBadge.textContent = capped;
  els.chatUnreadBadge.hidden = false;
}

function resetChatIndicators() {
  unreadMessages = 0;
  updateUnreadBadge();
}

function showPopup(name, text) {
  const toast = document.createElement("article");
  toast.className = "toast";

  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = `${name} sent a message`;

  const body = document.createElement("div");
  body.className = "toast-body";
  const trimmed = text.trim();
  body.textContent = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;

  toast.append(title, body);
  els.toastStack.appendChild(toast);

  if (els.toastStack.children.length > 4) {
    els.toastStack.firstElementChild?.remove();
  }

  toast.addEventListener("click", () => {
    if (isRemoteFullscreen) {
      setChatCollapsed(false);
    }
    clearPopups();
  });

  window.setTimeout(() => {
    toast.classList.add("is-out");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 3800);
}

function clearPopups() {
  els.toastStack.innerHTML = "";
}

function requestControlAccess() {
  if (role !== "viewer") return;

  if (!roomId || !hostId) {
    alert("Join a room with an active host first.");
    return;
  }

  if (controlViewerId === clientId) {
    renderLocalSystem("You already have control access.");
    return;
  }

  if (pendingControlRequest) return;

  const ok = send({ type: "control-request" });
  if (!ok) {
    alert("Control request failed. Realtime connection is unavailable.");
    return;
  }

  pendingControlRequest = true;
  renderLocalSystem("Control request sent to host.");
  updateControlUi();
}

function releaseControlAccess() {
  if (role !== "viewer" || controlViewerId !== clientId) return;

  const ok = send({ type: "control-release" });
  if (!ok) {
    alert("Could not release control right now.");
    return;
  }

  renderLocalSystem("Released control access.");
}

function revokeControlAccess() {
  if (role !== "host" || !controlViewerId) return;

  const ok = send({ type: "control-revoke" });
  if (!ok) {
    alert("Could not revoke control right now.");
    return;
  }

  renderLocalSystem("Revoked viewer control access.");
}

function handleControlRequest(msg) {
  if (role !== "host") return;

  const requesterId = String(msg?.fromId || "");
  if (!requesterId) return;

  const requesterName = String(msg?.name || participantNames.get(requesterId) || "viewer");
  pendingViewerRequests.add(requesterId);
  renderLocalSystem(`${requesterName} requested control access.`);
  updateControlUi();
  renderViewerAccessList();
}

function applyControlStatus(msg) {
  const granted = Boolean(msg?.granted);
  const viewerId = String(msg?.viewerId || "");
  const viewerName = String(msg?.viewerName || participantNames.get(viewerId) || "viewer");
  const hadSelfControl = controlViewerId === clientId;

  if (viewerId) {
    pendingViewerRequests.delete(viewerId);
  }

  if (granted && viewerId) {
    controlViewerId = viewerId;
    controlViewerName = viewerName;
    pendingControlRequest = false;
    renderLocalSystem(`${viewerName} now has control access.`);
  } else {
    controlViewerId = "";
    controlViewerName = "";
    pendingControlRequest = false;
    hideControlPointer(true);

    if (viewerId) {
      renderLocalSystem(`${viewerName} control access ended.`);
    }

    if (hadSelfControl || viewerId === clientId) {
      renderLocalSystem("You no longer have control access.");
    }
  }

  updateControlUi();
  renderViewerAccessList();
  updateControlCaptureState();
}

function updateControlUi() {
  const hasRoom = Boolean(roomId);
  const viewerHasControl = role === "viewer" && controlViewerId === clientId;
  const hasActiveController = Boolean(controlViewerId);

  els.requestControlBtn.hidden = role !== "viewer";
  els.releaseControlBtn.hidden = role !== "viewer";
  els.revokeControlBtn.hidden = role !== "host";

  els.requestControlBtn.disabled =
    role !== "viewer" || !hasRoom || !hostId || pendingControlRequest || viewerHasControl;
  els.releaseControlBtn.disabled = !viewerHasControl;
  els.revokeControlBtn.disabled = role !== "host" || !hasActiveController;

  if (!hasRoom || role === "none") {
    els.controlState.textContent = "Join a room to use collaborative control.";
    return;
  }

  if (role === "host") {
    if (hasActiveController) {
      const name = controlViewerName || participantNames.get(controlViewerId) || "viewer";
      els.controlState.textContent = `${name} currently has control access.`;
    } else {
      const pendingCount = pendingViewerRequests.size;
      if (pendingCount > 0) {
        els.controlState.textContent = `Pending requests: ${pendingCount}. Use the viewer access list below.`;
      } else {
        els.controlState.textContent = "No viewer has control access. Use the viewer access list below.";
      }
    }
    return;
  }

  if (viewerHasControl) {
    els.controlState.textContent =
      "You have control access. Move/click on the stream to collaborate with host.";
    return;
  }

  if (pendingControlRequest) {
    els.controlState.textContent = "Waiting for host approval...";
    return;
  }

  if (hasActiveController) {
    const name = controlViewerName || participantNames.get(controlViewerId) || "Another viewer";
    els.controlState.textContent = `${name} currently has control access.`;
    return;
  }

  els.controlState.textContent = "Request access and wait for host approval.";
}

function updateControlCaptureState() {
  const canControl = role === "viewer" && roomId && controlViewerId === clientId;

  els.remoteVideo.classList.toggle("can-control", Boolean(canControl));

  if (canControl) {
    bindControlCapture();
  } else {
    unbindControlCapture();
  }
}

function bindControlCapture() {
  if (controlCaptureBound) return;

  els.remoteVideo.addEventListener("pointermove", onControlPointerMove);
  els.remoteVideo.addEventListener("pointerdown", onControlPointerDown);
  els.remoteVideo.addEventListener("click", onControlClickBlock);
  els.remoteVideo.addEventListener("dblclick", onControlClickBlock);
  els.remoteVideo.addEventListener("contextmenu", onControlClickBlock);

  if (!controlKeyboardBound) {
    window.addEventListener("keydown", onControlKeyDown, true);
    controlKeyboardBound = true;
  }

  controlCaptureBound = true;
}

function unbindControlCapture() {
  if (!controlCaptureBound) return;

  els.remoteVideo.removeEventListener("pointermove", onControlPointerMove);
  els.remoteVideo.removeEventListener("pointerdown", onControlPointerDown);
  els.remoteVideo.removeEventListener("click", onControlClickBlock);
  els.remoteVideo.removeEventListener("dblclick", onControlClickBlock);
  els.remoteVideo.removeEventListener("contextmenu", onControlClickBlock);

  if (controlKeyboardBound) {
    window.removeEventListener("keydown", onControlKeyDown, true);
    controlKeyboardBound = false;
  }

  controlCaptureBound = false;
}

function onControlPointerMove(event) {
  if (controlViewerId !== clientId || role !== "viewer") return;

  const now = Date.now();
  if (now - lastControlMoveAt < 45) return;
  lastControlMoveAt = now;

  sendControlInput("move", event.clientX, event.clientY);
}

function onControlPointerDown(event) {
  if (controlViewerId !== clientId || role !== "viewer") return;

  event.preventDefault();
  event.stopPropagation();

  if (typeof event.button === "number" && event.button !== 0) {
    return;
  }

  sendControlInput("click", event.clientX, event.clientY);
}

function onControlClickBlock(event) {
  if (controlViewerId !== clientId || role !== "viewer") return;
  event.preventDefault();
  event.stopPropagation();
}

function onControlKeyDown(event) {
  if (controlViewerId !== clientId || role !== "viewer") return;

  const activeEl = document.activeElement;
  if (
    activeEl &&
    (activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA" ||
      activeEl.tagName === "SELECT" ||
      activeEl.isContentEditable)
  ) {
    return;
  }

  const keyLabel = formatControlKey(event);
  if (!keyLabel) return;

  event.preventDefault();
  event.stopPropagation();

  send({
    type: "control-input",
    input: {
      kind: "key",
      key: keyLabel
    }
  });
}

function formatControlKey(event) {
  if (!event || typeof event.key !== "string") return "";
  if (event.key === "Dead") return "";

  const base = normalizeControlKey(event.key);
  if (!base) return "";

  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Meta");

  if (base.length > 1 && event.shiftKey) {
    modifiers.push("Shift");
  }

  if (!modifiers.length) {
    return base;
  }

  return `${modifiers.join("+")}+${base}`;
}

function normalizeControlKey(key) {
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  return key;
}

function keepLiveVideoPlaying(event) {
  const video = event.currentTarget;
  if (!video || !video.srcObject) return;

  const playPromise = video.play?.();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {
      // If browser blocks autoplay, user interaction is required.
    });
  }
}

function sanitizeShareMode(value) {
  const next = String(value || "window").toLowerCase();
  if (next === "tab" || next === "window" || next === "screen") {
    return next;
  }
  return "window";
}

function shareModeLabel(mode) {
  if (mode === "tab") return "tab share";
  if (mode === "screen") return "entire screen share";
  return "window share";
}

function formatRealtimeError(error) {
  const message = String(error?.message || error?.code || "Unknown realtime error");
  const lowered = message.toLowerCase();

  if (lowered.includes("404") || lowered.includes("not found")) {
    return (
      "Firebase Realtime Database endpoint was not found (404). " +
      "Open Firebase Console -> Realtime Database, create the database, then copy the exact databaseURL into firebase-config.js."
    );
  }

  if (lowered.includes("permission") || lowered.includes("denied")) {
    return (
      "Firebase rules blocked access. Update Realtime Database rules to allow this app's read/write access."
    );
  }

  if (lowered.includes("offline") || lowered.includes("network")) {
    return "Network/realtime connection issue. Check internet access and Firebase project status.";
  }

  return message;
}

function sendControlInput(kind, clientX, clientY) {
  const rect = els.remoteVideo.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  send({
    type: "control-input",
    input: {
      kind,
      x,
      y
    }
  });
}

function handleControlInput(msg) {
  const fromId = String(msg?.fromId || "");
  if (!fromId) return;
  if (controlViewerId && fromId !== controlViewerId) return;

  const input = msg?.input;
  if (!input || typeof input !== "object") return;

  if (input.kind === "key") {
    const key = String(input.key || "").trim();
    if (!key) return;
    showControlKeystroke(msg.name || "viewer", key);
    return;
  }

  const x = Number(input.x);
  const y = Number(input.y);
  const kind = input.kind === "click" ? "click" : "move";
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  showControlPointer(kind, x, y);
}

function showControlPointer(kind, xNorm, yNorm) {
  const targetVideo = role === "host" ? els.localVideo : els.remoteVideo;
  if (!targetVideo) return;

  const rect = targetVideo.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;

  const x = rect.left + Math.max(0, Math.min(1, xNorm)) * rect.width;
  const y = rect.top + Math.max(0, Math.min(1, yNorm)) * rect.height;

  els.controlPointer.style.left = `${x}px`;
  els.controlPointer.style.top = `${y}px`;
  els.controlPointer.hidden = false;

  if (controlPointerTimer) {
    clearTimeout(controlPointerTimer);
  }
  controlPointerTimer = setTimeout(() => {
    hideControlPointer();
  }, 1400);

  if (kind === "click") {
    els.controlPulse.hidden = false;
    els.controlPulse.style.left = `${x}px`;
    els.controlPulse.style.top = `${y}px`;
    els.controlPulse.style.animation = "none";
    void els.controlPulse.offsetWidth;
    els.controlPulse.style.animation = "";
    window.setTimeout(() => {
      els.controlPulse.hidden = true;
    }, 420);
  }
}

function hideControlPointer(force = false) {
  if (controlPointerTimer) {
    clearTimeout(controlPointerTimer);
    controlPointerTimer = null;
  }

  if (force) {
    els.controlPulse.hidden = true;
  }

  els.controlPointer.hidden = true;
}

function showControlKeystroke(name, key) {
  const toast = document.createElement("article");
  toast.className = "toast";

  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = `${name} typed`;

  const body = document.createElement("div");
  body.className = "toast-body";
  body.textContent = key;

  toast.append(title, body);
  els.toastStack.appendChild(toast);

  if (els.toastStack.children.length > 4) {
    els.toastStack.firstElementChild?.remove();
  }

  window.setTimeout(() => {
    toast.classList.add("is-out");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 2200);
}

function resetControlState() {
  controlViewerId = "";
  controlViewerName = "";
  pendingControlRequest = false;
  pendingViewerRequests.clear();
  viewerParticipants = [];
  lastControlMoveAt = 0;

  hideControlPointer(true);
  unbindControlCapture();
  participantNames.clear();

  updateControlUi();
  renderViewerAccessList();
}

function grantViewerAccess(viewerId) {
  if (role !== "host" || !viewerId) return;

  const ok = send({
    type: "control-response",
    targetId: viewerId,
    granted: true
  });

  if (!ok) {
    alert("Could not grant control access right now.");
    return;
  }

  pendingViewerRequests.delete(viewerId);
  updateControlUi();
  renderViewerAccessList();
}

function denyViewerAccess(viewerId) {
  if (role !== "host" || !viewerId) return;

  const ok = send({
    type: "control-response",
    targetId: viewerId,
    granted: false
  });

  if (!ok) {
    alert("Could not deny request right now.");
    return;
  }

  const name = participantNames.get(viewerId) || "viewer";
  pendingViewerRequests.delete(viewerId);
  renderLocalSystem(`Denied control request from ${name}.`);
  updateControlUi();
  renderViewerAccessList();
}

function removeViewerAccess(viewerId) {
  if (role !== "host" || !viewerId) return;

  if (controlViewerId === viewerId) {
    revokeControlAccess();
    return;
  }

  pendingViewerRequests.delete(viewerId);
  updateControlUi();
  renderViewerAccessList();
}

function renderViewerAccessList() {
  const isHost = role === "host" && Boolean(roomId);
  els.hostViewerPanel.hidden = !isHost;

  if (!isHost) {
    els.viewerAccessList.innerHTML = "";
    return;
  }

  const viewers = viewerParticipants;
  if (!viewers.length) {
    const empty = document.createElement("div");
    empty.className = "viewer-access-empty";
    empty.textContent = "No viewers connected yet.";
    els.viewerAccessList.innerHTML = "";
    els.viewerAccessList.appendChild(empty);
    return;
  }

  els.viewerAccessList.innerHTML = "";

  for (const viewer of viewers) {
    if (!viewer || !viewer.id) continue;

    const viewerId = viewer.id;
    const viewerName = viewer.name || "viewer";
    const hasAccess = viewerId === controlViewerId;
    const isPending = pendingViewerRequests.has(viewerId);

    const row = document.createElement("div");
    row.className = "viewer-access-item";

    const meta = document.createElement("div");
    meta.className = "viewer-access-meta";

    const name = document.createElement("span");
    name.className = "viewer-access-name";
    name.textContent = viewerName;
    meta.appendChild(name);

    if (hasAccess) {
      const badge = document.createElement("span");
      badge.className = "viewer-badge is-active";
      badge.textContent = "Has Access";
      meta.appendChild(badge);
    }

    if (isPending) {
      const badge = document.createElement("span");
      badge.className = "viewer-badge is-request";
      badge.textContent = "Request Pending";
      meta.appendChild(badge);
    }

    const actions = document.createElement("div");
    actions.className = "viewer-access-actions";

    const grantBtn = document.createElement("button");
    grantBtn.type = "button";
    grantBtn.className = "btn btn-primary btn-sm";
    grantBtn.textContent = hasAccess ? "Access Active" : isPending ? "Approve" : "Give Access";
    grantBtn.disabled = hasAccess;
    grantBtn.addEventListener("click", () => grantViewerAccess(viewerId));
    actions.appendChild(grantBtn);

    if (isPending && !hasAccess) {
      const denyBtn = document.createElement("button");
      denyBtn.type = "button";
      denyBtn.className = "btn btn-danger btn-sm";
      denyBtn.textContent = "Deny";
      denyBtn.addEventListener("click", () => denyViewerAccess(viewerId));
      actions.appendChild(denyBtn);
    }

    if (hasAccess) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-danger btn-sm";
      removeBtn.textContent = "Remove Access";
      removeBtn.addEventListener("click", () => removeViewerAccess(viewerId));
      actions.appendChild(removeBtn);
    }

    row.append(meta, actions);
    els.viewerAccessList.appendChild(row);
  }
}

function sanitizeRoom(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 24);
}

function sanitizeName(value) {
  return (
    String(value || "guest")
      .trim()
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .slice(0, 24) || "guest"
  );
}

function createClientId() {
  try {
    return `u_${crypto.randomUUID().slice(0, 12)}`;
  } catch {
    return `u_${Math.random().toString(36).slice(2, 14)}`;
  }
}
