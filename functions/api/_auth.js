// _auth.js — secreto compartido para toda /api.
//
// Lo necesitan TODAS las rutas, no solo las de escritura: sin secreto, cualquiera
// que encuentre la URL puede consultar tu base de conocimiento, o peor, hacer
// poll de /api/next y leer las consultas que hace otro.
//
// Configurar (nunca commitear):  wrangler pages secret put API_SECRET
//
// Falla cerrado: sin secreto configurado no se sirve nada, en vez de dejar tus
// colecciones abiertas a quien pase.

export function checkAuth(request, env) {
  const expected = env?.API_SECRET;
  if (!expected) {
    return new Response(
      JSON.stringify({ error: 'API_SECRET sin configurar — corré: wrangler pages secret put API_SECRET' }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('X-API-Key') || '';
  if (!token || !timingSafeEqual(token, expected)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return null;
}

// Comparación en tiempo constante: que no se pueda adivinar byte a byte.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
