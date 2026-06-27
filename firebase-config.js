import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js"; // <-- Das hier war falsch!

// PLATZHALTER: Ersetze das hier mit deinen echten Firebase-Daten!
const firebaseConfig = {
  apiKey: "AIzaSyBvIrVfQBVXMyKnw5Ye_c7b-ErzNOZsoa0",
  authDomain: "himusic-93742.firebaseapp.com",
  projectId: "himusic-93742",
  storageBucket: "himusic-93742.firebasestorage.app",
  messagingSenderId: "887032102323",
  appId: "1:887032102323:web:30b8d5d8af66a975041fc6"
};


const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);