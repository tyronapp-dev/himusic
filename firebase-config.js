import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "DEIN_API_KEY",
  authDomain: "himusic-XXXXX.firebaseapp.com",
  projectId: "himusic-XXXXX",
  storageBucket: "himusic-XXXXX.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcd1234efgh"
};

const app = initializeApp(firebaseConfig);

// iOS Fix: Zwingt die PWA, den Login tief im Gerätespeicher festzusetzen
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence]
});