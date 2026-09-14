// EXPIREDNOT — Firebase Configuration (Auth + Firestore Database)
const firebaseConfig = {
  apiKey: "AIzaSyB87qlEwYTAhaCAiCp0llrWMs__uNoqPDo",
  authDomain: "expirednot.firebaseapp.com",
  projectId: "expirednot",
  storageBucket: "expirednot.firebasestorage.app",
  messagingSenderId: "372651205564",
  appId: "1:372651205564:web:47dae5167e80375010c1b9"
};

// Initialize Firebase App, Auth, and Firestore
if (typeof firebase !== 'undefined') {
  if (!firebase.apps || !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  // Authentication
  window.firebaseAuth = firebase.auth();
  window.googleAuthProvider = new firebase.auth.GoogleAuthProvider();
  window.googleAuthProvider.setCustomParameters({ prompt: 'select_account' });
  
  // DATABASE: Initialize Cloud Firestore
  window.db = firebase.firestore();

  console.log('Firebase Auth & Firestore Database initialized successfully.');
} else {
  console.warn('Firebase SDK compat scripts not detected.');
}