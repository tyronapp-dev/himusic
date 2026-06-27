import { auth } from "./firebase-config.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js"; // <-- Das hier war falsch!

document.getElementById('login-btn').addEventListener('click', async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('error-msg');

    // Fehlermeldung vorher zurücksetzen
    errorMsg.style.display = 'none';
    errorMsg.innerText = '';

    try {
        // Firebase Login-Versuch
        await signInWithEmailAndPassword(auth, email, password);
        
        // Bei Erfolg weiter zur App-Hauptseite
        window.location.href = "index.html";
    } catch (error) {
        // Fehler anzeigen (z.B. falsches Passwort)
        errorMsg.style.display = 'block';
        errorMsg.innerText = "Fehler: Falsche Zugangsdaten oder Netzwerkproblem.";
        console.error(error);
    }
});