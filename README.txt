SMART VEGETABLE STORE - FIXED VERSION

What was fixed:
1. Responsive mobile/desktop dashboard and navigation.
2. Mobile sidebar no longer creates the broken giant green area.
3. Inventory is stored in Firebase Firestore so the same inventory appears on other devices.
4. First-time localStorage inventory is migrated to Firestore when the cloud collection is empty.
5. Firebase Anonymous Authentication is used so Firestore can be protected by authenticated rules.
6. Inventory changes update live on other devices using Firestore realtime listener.
7. Invoice remains device-local; inventory is shared.
8. Stock Out cannot be greater than Stock In.

IMPORTANT FIREBASE SETUP:
A) Firebase Console -> Authentication -> Sign-in method -> enable Anonymous.
B) Firestore Database -> Rules -> use the included firestore.rules rules.
C) Deploy/upload these files to the same GitHub Pages site:
   index.html
   style.css
   script.js
   firebase.js
   firestore.rules (rules are pasted in Firebase Console; this file itself need not be public)

The Firebase config in firebase.js is the config supplied in the uploaded file.
