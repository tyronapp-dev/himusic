import { auth } from "./firebase-config.js";
import { signInWithEmailAndPassword, setPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

document.getElementById('login-btn').addEventListener('click', async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const rememberMe = document.getElementById('remember-me').checked;
    const errorMsg = document.getElementById('error-msg');

    errorMsg.style.display = 'none';
    errorMsg.innerText = '';

    try {
        // Firebase anweisen, den Login dauerhaft oder nur für die Sitzung zu speichern
        const persistenceType = rememberMe ? browserLocalPersistence : browserSessionPersistence;
        await setPersistence(auth, persistenceType);
        
        // Erst danach einloggen
        await signInWithEmailAndPassword(auth, email, password);
        
        window.location.href = "index.html";
    } catch (error) {
        errorMsg.style.display = 'block';
        errorMsg.innerText = "Fehler: Falsche Zugangsdaten oder Netzwerkproblem.";
        console.error(error);
    }
});