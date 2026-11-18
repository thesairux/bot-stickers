/**
 * Limita cuántas tareas corren al mismo tiempo (para no lanzar 20 ffmpeg a la vez).
 * @param {number} max
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(max) {
  let running = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  const next = () => {
    if (running >= max || queue.length === 0) return;
    running += 1;
    queue.shift()();
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            next();
          });
      });
      next();
    });
}

/**
 * Límite de solicitudes por persona en una ventana de tiempo
 * (para que nadie llene tu WhatsApp de stickers).
 * take() devuelve 'ok', 'limited-first' (la primera vez que se pasa, para
 * avisarle) o 'limited'.
 * @param {number} max
 * @param {number} windowMs
 */
export function createRateLimiter(max, windowMs) {
  const hits = new Map();
  const warned = new Map();

  return {
    take(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (hits.size > 1000) {
        for (const [k, list] of hits) {
          if (!list.some((t) => now - t < windowMs)) {
            hits.delete(k);
            warned.delete(k);
          }
        }
      }
      if (recent.length >= max) {
        hits.set(key, recent);
        const warnedAt = warned.get(key);
        if (warnedAt !== undefined && now - warnedAt < windowMs) return 'limited';
        warned.set(key, now);
        return 'limited-first';
      }
      recent.push(now);
      hits.set(key, recent);
      return 'ok';
    },
  };
}
