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
```

## 3) Run locally

```powershell
cd "c:\Users\2must\Downloads\shared browser"
npm start
```

Then open:
- `http://localhost:5500`

`localhost` only works for your machine.

## 3.1) Free deploy via GitHub Pages
This project now includes a GitHub Pages workflow in `.github/workflows/deploy-pages.yml`.

1. Push to `main` on your GitHub repo.
2. In GitHub: **Settings -> Pages -> Build and deployment**.
3. Set Source to **GitHub Actions**.
4. Wait for workflow **Deploy Static App to GitHub Pages** to complete.
5. Share your site URL:
  `https://Mustafa-exe.github.io/shared-browser/`

Because signaling/chat/presence now run via Firebase Realtime Database, no paid Node hosting is required for production use.

## 4) Usage
1. Host opens app, enters room code, clicks **Host Room**.
2. Viewers open app, enter same room code, click **Join**.
3. Host chooses share mode (**Entire Window**, **Browser Tab**, **Entire Screen**) and clicks **Start Screen Share**.
4. Viewers watch the host stream in near real time.
5. Everyone chats instantly.
6. A viewer can click **Request Control** to ask host for collaboration access.
7. Host sees all connected viewers in the **Viewer Access Control** panel and can approve/deny/remove access at any time.
8. When approved, the viewer can move/click/type and both sides see live control cues (cursor/click + key actions) for collaboration.

## Control limitation (important)
Directly controlling another user's OS window/tab from normal browser screen-share is blocked by browser security.
This app provides collaborative control cues and signaling, but it cannot inject raw mouse/keyboard into arbitrary host desktop apps.

## Performance notes
- Chat/presence: Firebase realtime updates.
- Live view: direct peer-to-peer media stream from host tab to each viewer.
- Remaining delay mostly depends on viewer network and browser media buffering.

## Next upgrades for production quality
- Add Firebase Auth + strict per-room security rules.
- Add TURN servers for stronger WebRTC connectivity behind strict NATs.
- Add host moderation (kick/mute).
- Replace screenshot frames with GPU-accelerated WebRTC video encoding for lower cloud-stream latency.
