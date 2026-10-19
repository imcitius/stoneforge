import { Socket } from 'node:net';

type SocketPrototype = { setTypeOfService?: (value: number) => unknown };
const guarded = new WeakSet<SocketPrototype>();

/** Remove when Electron's bundled Undici includes nodejs/undici#5547. */
export function installSocketWorkaround(
  prototype: SocketPrototype = Socket.prototype as SocketPrototype,
  platform: string = process.platform,
): void {
  const original = prototype.setTypeOfService;
  if (platform !== 'darwin' || !original || guarded.has(prototype)) return;
  prototype.setTypeOfService = function (value: number) {
    try { return original.call(this, value); }
    catch (error) {
      // Undici 7.29.1 calls this outside the fetch promise's error boundary.
      // QoS is best-effort; macOS can reject it on a valid HTTP socket.
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EINVAL' &&
          (error as NodeJS.ErrnoException).syscall === 'setTypeOfService') return this;
      throw error;
    }
  };
  guarded.add(prototype);
}

installSocketWorkaround();
