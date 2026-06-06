/**
 * WebSocket Event Bridge
 *
 * A lightweight in-process event bus that companion/server.ts subscribes to.
 * Existing main-process code calls pushEvent() to fan out IPC push-events
 * (things normally sent via webContents.send) to all connected WebSocket clients.
 *
 * This file has NO imports from Electron so it can be imported in tests.
 */

import { EventEmitter } from 'node:events'

export interface WsBridgeEvent {
  channel: string
  args: unknown[]
}

class WsBridge extends EventEmitter {
  /** Emit an event to all connected WS clients.
   *  @param channel  The IPC channel name (e.g. 'overlay-data', 'zone-changed')
   *  @param args     Zero or more serialisable arguments.
   */
  push(channel: string, ...args: unknown[]): void {
    this.emit('event', { channel, args } satisfies WsBridgeEvent)
  }
}

export const wsBridge = new WsBridge()
