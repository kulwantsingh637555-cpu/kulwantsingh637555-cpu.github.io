SMART VEGETABLE STORE - FIREBASE SETUP

1. Firebase Console -> Security -> Authentication -> Sign-in method -> Anonymous -> Enable -> Save.
2. Firebase Console -> Security -> Authentication -> Settings -> Authorized domains. Add:
   kulwantsingh637555-cpu.github.io
   localhost
   127.0.0.1
3. Firebase Console -> Firestore Database -> Rules. Use the included firestore.rules file.
4. GitHub Pages: upload index.html, style.css, script.js, firebase.js.
5. Open the live GitHub Pages URL and press Retry if the status still shows unavailable.

The app uses Anonymous Authentication so Firestore rules can safely require request.auth != null.
Do NOT change the rules to public read/write (request.auth == null / true).
