// Service worker mínimo: el juego es online, así que todo va por la red (sin caché que pueda dejar versiones viejas).
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});
