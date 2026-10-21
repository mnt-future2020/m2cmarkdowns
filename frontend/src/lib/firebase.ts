import { initializeApp, getApps } from 'firebase/app';

// Fully env-driven — no project values are hardcoded. Set NEXT_PUBLIC_FIREBASE_*
// in the host (Firebase Console → Project Settings → Your apps → Web).
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
};

// Initialize only once (Next.js hot reloads)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export { app };

// VAPID key for web push — generate from Firebase Console → Cloud Messaging → Web Push certificates
export const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || '';
