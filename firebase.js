import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDM_2MYad1LPpEBPEQhkhZKsdy20WpQoww",
  authDomain: "smart-hotel-veggis-store.firebaseapp.com",
  projectId: "smart-hotel-veggis-store",
  storageBucket: "smart-hotel-veggis-store.firebasestorage.app",
  messagingSenderId: "313226803394",
  appId: "1:313226803394:web:64915703ffb27a673c635b",
  measurementId: "G-CMXXCF84QN"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
