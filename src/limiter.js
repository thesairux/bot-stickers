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
