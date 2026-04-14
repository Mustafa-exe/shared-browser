# SyncChrome - Shared Browser + Instant Chat

A web-based host/viewer shared session app with:
- Host-controlled room sessions
- Shared search/navigation links
- Realtime chat (Firebase Realtime Database)
- Low-latency sync packets over WebRTC DataChannel
- Live host Chrome-tab streaming over WebRTC media tracks
- Cloud browser session rendered by Playwright and streamed to clients
- YouTube playback synchronization (play/pause/seek drift correction)

## Important reality check
This is **not pixel-streaming** like Hyperbeam's cloud browser. Browser security rules do not allow full remote control/view of arbitrary tabs from a normal web page.

This app provides a near real-time shared watch/search experience by combining:
- live host tab stream (what host is seeing in Chrome)
- cloud browser stream (single remote browser for everyone)
- URL/navigation state
- media playback state
- chat messages

## 1) Firebase setup
1. Create a Firebase project.
2. Enable **Realtime Database**.
3. Set rules for MVP testing (tighten later):

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

4. Copy `firebase-config.example.js` to `firebase-config.js` and fill credentials.

5. For better WebRTC success across different networks, add TURN details in `firebase-config.js` (optional but recommended):

```javascript
export const rtcConfig = {
  iceServers: [
    {
      urls: "turn:YOUR_TURN_HOST:3478",
      username: "YOUR_TURN_USERNAME",
      credential: "YOUR_TURN_CREDENTIAL"
    }
  ]
};
```

## 2) Install dependencies

```powershell
cd "c:\Users\2must\Downloads\shared browser"
npm install
npx playwright install chrome
```

If Chrome channel is unavailable on your machine, backend launch falls back to bundled Chromium.

## 3) Run locally

```powershell
cd "c:\Users\2must\Downloads\shared browser"
npm start
```

Then open:
- `http://localhost:5500`

`localhost` only works for the machine running the server.

For other users to join:
- Same LAN: share `http://<HOST_LAN_IP>:5500` and allow port 5500 in firewall.
- Different networks: deploy to a public host or use a tunnel/reverse proxy, then share that public URL.

The cloud WebSocket endpoint (`/cloud`) is same-origin, so viewers must open the same LAN/public origin as the host.

## 4) Usage
1. Host opens app, enters room code, clicks **Host Room**.
2. Viewers open app, enter same room code, click **Join**.
3. Host clicks **Connect Cloud Browser**.
4. Host controls the cloud browser with **Cloud Go**, frame clicks, scroll, and typing tools.
5. Viewers watch the same cloud browser stream in near real time.
6. Optional: Host can still use **Start Chrome Tab Share** for direct tab sharing.
7. Everyone chats instantly.

## Performance notes
- Chat/presence: Firebase realtime updates.
- Playback sync: direct peer-to-peer data channels with periodic correction every 700ms while playing.
- Live view: direct peer-to-peer media stream from host tab to each viewer.
- Cloud stream: Playwright screenshots pushed over WebSocket.
- Remaining delay mostly depends on viewer network and browser media buffering.

## Next upgrades for production quality
- Add Firebase Auth + strict per-room security rules.
- Add TURN servers for stronger WebRTC connectivity behind strict NATs.
- Add host moderation (kick/mute).
- Replace screenshot frames with GPU-accelerated WebRTC video encoding for lower cloud-stream latency.
