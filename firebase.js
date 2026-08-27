/* VeggieStock Firebase configuration */
const firebaseConfig = {
  apiKey: "AIzaSyDM_2MYad1LPpEBPEQhkhZKsdy20WpQoww",
  authDomain: "smart-hotel-veggis-store.firebaseapp.com",
  projectId: "smart-hotel-veggis-store",
  storageBucket: "smart-hotel-veggis-store.firebasestorage.app",
  messagingSenderId: "313226803394",
  appId: "1:313226803394:web:64915703ffb27a673c635b",
  measurementId: "G-CMXXCF84QN"
};

try {
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  window.db = firebase.firestore();
} catch (e) {
  console.error("Firebase init failed:", e);
  window.db = null;
}
