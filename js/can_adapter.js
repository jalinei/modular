// Cross-platform CAN bus adapter
// - Linux: uses `socketcan` (raw channel)
// - Windows: placeholder for vendor driver bindings via `ffi-napi`
//
// Exposes a minimal interface compatible with our ISO-TP helpers:
//   const bus = await createBus({ channel: "can0" });
//   await bus.send({ arbitration_id: 0x18EF0112, data: Buffer.from([...]), is_extended_id: true });
//   const msg = await bus.recv(250); // timeout ms
//   await bus.shutdown();

'use strict';

const os = require('os');

class Queue {
  constructor() { this.q = []; this.waiters = []; }
  push(x) {
    // Prefer delivering to a matching waiter (filtered receive) first
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (!w.filter || w.filter(x)) {
        this.waiters.splice(i, 1);
        try { clearTimeout(w.timer); } catch {}
        w.resolve(x);
        return;
      }
    }
    this.q.push(x);
  }
  async pop(timeoutMs, filter) {
    // If an item already in queue matches, return it
    if (this.q.length) {
      if (!filter) return this.q.shift();
      for (let i = 0; i < this.q.length; i++) {
        if (filter(this.q[i])) {
          const x = this.q[i];
          this.q.splice(i, 1);
          return x;
        }
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Timeout: resolve null and remove waiter if still present
        for (let i = 0; i < this.waiters.length; i++) {
          if (this.waiters[i].resolve === resolve) { this.waiters.splice(i, 1); break; }
        }
        resolve(null);
      }, Math.max(0, timeoutMs | 0));
      this.waiters.push({ resolve, filter, timer });
    });
  }
}

async function createLinuxBus({ channel = 'can0' } = {}) {
  let can;
  try {
    can = require('socketcan');
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    throw new Error(
      'SocketCAN module load failed. This usually means the native module was built for a different Node/Electron version. ' +
      'Please rebuild native modules for Electron (see README or run: npx electron-rebuild -f -w socketcan).\nOriginal error: ' + msg
    );
  }
  const ch = can.createRawChannel(channel, true);
  const q = new Queue();

  function onMessage(frame) {
    // Normalize into python-can-like object
    // socketcan msg: { id, ext, data: Buffer, rtr }
    const msg = {
      arbitration_id: frame.id >>> 0,
      data: Buffer.from(frame.data || []),
      dlc: (frame.data && frame.data.length) || 0,
      is_extended_id: !!frame.ext,
    };
    q.push(msg);
  }

  // socketcan Channel supports EventEmitter-style listeners
  if (typeof ch.addListener === 'function') ch.addListener('onMessage', onMessage);
  else if (typeof ch.on === 'function') ch.on('onMessage', onMessage);
  ch.start();

  return {
    async send({ arbitration_id, data, is_extended_id }) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
      // Ensure <= 8 bytes; pad if shorter to comply with classic CAN data length
      const padded = buf.length < 8 ? Buffer.concat([buf, Buffer.alloc(8 - buf.length, 0)]) : buf.slice(0, 8);
      ch.send({ id: arbitration_id >>> 0, ext: !!is_extended_id, data: padded });
    },
    async recv(timeoutMs, filter) {
      return q.pop(timeoutMs == null ? 0 : timeoutMs, filter);
    },
    async shutdown() {
      try { ch.stop(); } catch { /* ignore */ }
      try {
        if (typeof ch.removeListener === 'function') ch.removeListener('onMessage', onMessage);
        else if (typeof ch.off === 'function') ch.off('onMessage', onMessage);
        else if (typeof ch.removeAllListeners === 'function') ch.removeAllListeners('onMessage');
      } catch { /* ignore */ }
    },
    // Expose lightweight event subscription passthrough for listeners (e.g., aggregators)
    addListener(evt, handler) {
      if (evt !== 'onMessage' || typeof handler !== 'function') return;
      if (typeof ch.addListener === 'function') ch.addListener('onMessage', handler);
      else if (typeof ch.on === 'function') ch.on('onMessage', handler);
    },
    removeListener(evt, handler) {
      if (evt !== 'onMessage' || typeof handler !== 'function') return;
      if (typeof ch.removeListener === 'function') ch.removeListener('onMessage', handler);
      else if (typeof ch.off === 'function') ch.off('onMessage', handler);
    },
    on(evt, handler) { this.addListener(evt, handler); },
    off(evt, handler) { this.removeListener(evt, handler); },
  };
}

async function createWindowsBus(/* { channel } */) {
  // Windows has no SocketCAN; binding depends on vendor driver (e.g., Kvaser, PEAK PCAN, NI-CAN).
  // Recommended approach: wrap the vendor C API using `ffi-napi` and expose the same interface
  // as the Linux bus above: send({ arbitration_id, data, is_extended_id }), recv(timeoutMs), shutdown().
  //
  // Example (pseudo):
  // const ffi = require('ffi-napi');
  // const ref = require('ref-napi');
  // const lib = ffi.Library('pcanbasic', { 'CAN_Write': [...], 'CAN_Read': [...], ... });
  // return { send: async (...) => lib.CAN_Write(...), recv: async (t) => { poll Read with timeout }, shutdown: async () => lib.CAN_Uninitialize(...) };
  throw new Error('Windows CAN bus not implemented. Use ffi-napi to bind your vendor driver and match the Bus interface.');
}

async function createBus(opts = {}) {
  if (os.platform() === 'linux') return createLinuxBus(opts);
  if (os.platform() === 'win32') return createWindowsBus(opts);
  throw new Error(`Unsupported platform: ${os.platform()}`);
}

module.exports = {
  createBus,
};
