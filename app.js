const els = {
  connStatus: document.getElementById("connStatus"),
  roleLabel: document.getElementById("roleLabel"),
  roomLabel: document.getElementById("roomLabel"),
  roomInput: document.getElementById("roomInput"),
  nameInput: document.getElementById("nameInput"),
  hostBtn: document.getElementById("hostBtn"),
  joinBtn: document.getElementById("joinBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  startShareBtn: document.getElementById("startShareBtn"),
  stopShareBtn: document.getElementById("stopShareBtn"),
  streamState: document.getElementById("streamState"),
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
  toastStack: document.getElementById("toastStack")
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const clientId = createClientId();
let displayName = localStorage.getItem("shared_browser_name") || "guest";
let ws = null;
let wsReadyPromise = null;
let roomId = "";
let role = "none";
let hostId = "";
let localStream = null;
let isRemoteFullscreen = false;
let isChatCollapsed = false;
let unreadMessages = 0;

const peers = new Map();

bootstrap();

function bootstrap() {
  els.nameInput.value = displayName;

  els.hostBtn.addEventListener("click", () => joinRoom("host"));
  els.joinBtn.addEventListener("click", () => joinRoom("viewer"));
  els.leaveBtn.addEventListener("click", () => leaveRoom());
  els.startShareBtn.addEventListener("click", () => startShare());
  els.stopShareBtn.addEventListener("click", () => stopShare());
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

  ensureSocket()
    .then(() => {
      if (!roomId) setStatus("Ready", true);
    })
    .catch(() => {
      setStatus("Disconnected", false);
      renderLocalSystem("Could not connect to server.");
    });

  window.addEventListener("beforeunload", () => {
    if (roomId) {
      send({ type: "leave" });
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
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

  try {
    await ensureSocket();
  } catch {
    alert("Server is offline. Start npm server first.");
    return;
  }

  roomId = nextRoom;
  role = nextRole;
  setRoleUi();

  const sent = send({
    type: "join",
    roomId,
    clientId,
    name: displayName,
    role: nextRole
  });

  if (!sent) {
    setStatus("Disconnected", false);
    alert("Failed to join. WebSocket not connected.");
  }
}

async function leaveRoom(options = {}) {
  const { silent = false } = options;

  if (roomId) {
    send({ type: "leave" });
  }

  stopShare(false);
  clearAllPeers();
  clearRemoteVideo();
  setRemoteFullscreen(false);
  resetChatIndicators();
  clearPopups();

  roomId = "";
  role = "none";
  hostId = "";

  setRoleUi();
  setCounts(0, 0);

  if (ws && ws.readyState === WebSocket.OPEN) {
    setStatus("Ready", true);
  } else {
    setStatus("Disconnected", false);
  }

  setStreamState("Join a room to start.");

  if (!silent) {
    renderLocalSystem("Left room.");
  }
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function ensureSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (wsReadyPromise) {
    return wsReadyPromise;
  }

  wsReadyPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl());
    ws = socket;

    let settled = false;

    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      if (ok) {
        resolve();
      } else {
        wsReadyPromise = null;
        reject(error || new Error("WebSocket connection failed"));
      }
    };

    socket.addEventListener("open", () => {
      if (!roomId) {
        setStatus("Ready", true);
      }
      done(true);
    });

    socket.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      await handleSocketMessage(msg);
    });

    socket.addEventListener("close", () => {
      ws = null;
      wsReadyPromise = null;

      const hadRoom = Boolean(roomId);
      if (hadRoom) {
        stopShare(false);
        clearAllPeers();
        clearRemoteVideo();
        setRemoteFullscreen(false);
        resetChatIndicators();
        clearPopups();
        roomId = "";
        role = "none";
        hostId = "";
        setRoleUi();
        setCounts(0, 0);
        setStreamState("Disconnected from server.");
        renderLocalSystem("Server connection closed.");
      }

      setStatus("Disconnected", false);
    });

    socket.addEventListener("error", () => {
      done(false, new Error("WebSocket error"));
    });
  });

  return wsReadyPromise;
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(payload));
  return true;
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
  hostId = payload.hostId || "";

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
    const stream = await getDisplayMediaCompat();
    localStream = stream;

    els.localVideo.srcObject = stream;
    els.localVideo.muted = true;
    setStreamState("You are live. Viewers should see your screen.");

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

async function getDisplayMediaCompat() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Screen sharing is not supported in this browser.");
  }

  const options = [
    {
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include"
    },
    {
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true
    },
    {
      video: true,
      audio: false
    }
  ];

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
    alert("Chat failed. WebSocket is disconnected.");
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
