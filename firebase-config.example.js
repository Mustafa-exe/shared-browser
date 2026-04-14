// Copy this file to firebase-config.js and fill values from Firebase project settings.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_AUTH_DOMAIN",
  databaseURL: "YOUR_DATABASE_URL",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_STORAGE_BUCKET",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Optional: custom ICE servers (TURN/STUN) for better cross-network connectivity.
// These entries are merged with default public STUN servers in app.js.
export const rtcConfig = {
  iceServers: [
    // {
    //   urls: "turn:YOUR_TURN_HOST:3478",
    //   username: "YOUR_TURN_USERNAME",
    //   credential: "YOUR_TURN_CREDENTIAL"
    // }
  ]
};

// Optional shorthand for a single TURN server.
// export const turnConfig = {
//   urls: "turn:YOUR_TURN_HOST:3478",
//   username: "YOUR_TURN_USERNAME",
//   credential: "YOUR_TURN_CREDENTIAL"
// };
