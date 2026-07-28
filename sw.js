// Service worker minimal : permet l'installation (PWA) sans mettre en cache
// (pas de risque de version périmée — tout passe par le réseau normalement).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* réseau par défaut */ });
