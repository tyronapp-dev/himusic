import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBvIrVfQBVXMyKnw5Ye_c7b-ErzNOZsoa0",
  authDomain: "himusic-93742.firebaseapp.com",
  projectId: "himusic-93742",
  storageBucket: "himusic-93742.firebasestorage.app",
  messagingSenderId: "887032102323",
  appId: "1:887032102323:web:30b8d5d8af66a975041fc6"
};

const app = initializeApp(firebaseConfig);

// iOS Fix: Zwingt die PWA, den Login tief im Gerätespeicher festzusetzen
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence]
});