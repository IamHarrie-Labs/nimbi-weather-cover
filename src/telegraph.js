/**
 * Telegraph WebSocket client.
 *
 * Live inference over the WebSocket rail. Unlike POST /engine/v1/ask (which is
 * x402-gated at $0.01 a call), `ask` on a wallet-authenticated socket is not
 * charged — the wallet only has to hold >= $1 USDC in the Diamond's escrow to
 * complete the handshake. That is what makes a continuously running agent
 * affordable.
 *
 * Auth is a challenge-response: connect with the address as a query param,
 * ask for a challenge, sign the server's message with personal_sign, send the
 * signature back.
 */

import { WebSocket } from "ws";
import { Wallet } from "ethers";

const DEFAULT_WS = "wss://devnode.telegraphprotocol.com/engine/ws";

export class Telegraph {
  /**
   * @param {string} privateKey  Base Sepolia key funded with escrow USDC.
   * @param {object} [opts]
   * @param {string} [opts.url]        WebSocket endpoint.
   * @param {number} [opts.askTimeout] Milliseconds to wait for one answer.
   * @param {(e:object)=>void} [opts.onEvent] Firehose of protocol events, for
   *   the dashboard: every message the socket sees, tagged.
   */
  constructor(privateKey, opts = {}) {
    this.wallet = new Wallet(privateKey);
    this.url = opts.url || process.env.TELEGRAPH_WS || DEFAULT_WS;
    this.askTimeout = opts.askTimeout ?? 45_000;
    this.onEvent = opts.onEvent || (() => {});
    this.ws = null;
    this.ready = false;
    /** Resolver for the ask currently in flight, if any. */
    this._pending = null;
    /** Serialises asks: the socket has no request ids to correlate on. */
    this._queue = Promise.resolve();
  }

  get address() {
    return this.wallet.address;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.url}?wallet_address=${this.wallet.address}`;
      this.ws = new WebSocket(url);

      const settleTimer = setTimeout(
        () => reject(new Error("handshake timed out after 30s")),
        30_000,
      );

      this.ws.on("open", () => {
        // The server waits for us; it does not greet an authenticated socket.
        this._send({ action: "auth_wallet" });
      });

      this.ws.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.onEvent({ dir: "in", type: msg.type, data: msg.data });

        switch (msg.type) {
          case "wallet_challenge": {
            // Sign the server's exact message text, not a reconstruction.
            const signature = await this.wallet.signMessage(msg.data.message);
            this._send({ action: "wallet_verify", signature });
            break;
          }
          case "wallet_verified":
            this.ready = true;
            break;

          case "connected":
            // Arrives after verification; the socket is now usable.
            clearTimeout(settleTimer);
            resolve(this);
            break;

          case "error":
            if (this._pending) {
              this._pending.reject(
                new Error(msg.data?.message || "engine error"),
              );
              this._pending = null;
            } else {
              clearTimeout(settleTimer);
              reject(new Error(msg.data?.message || "engine error"));
            }
            break;

          case "result":
            if (this._pending) {
              this._pending.resolve(msg.data);
              this._pending = null;
            }
            break;

          default:
            // `executing`, `pong`, `subscribed` and friends: informational.
            break;
        }
      });

      this.ws.on("close", () => {
        this.ready = false;
        if (this._pending) {
          this._pending.reject(new Error("socket closed mid-request"));
          this._pending = null;
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(settleTimer);
        reject(err);
      });
    });
  }

  _send(obj) {
    this.onEvent({ dir: "out", type: obj.action, data: obj });
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Ask the network a question. Routing is probabilistic, so asking the same
   * question repeatedly samples different miners — which is exactly how we
   * build a consensus view without needing each miner's private endpoint
   * shape.
   *
   * @returns {Promise<object>} the engine's result payload
   */
  ask(query) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (!this.ready) return reject(new Error("socket not authenticated"));

        const timer = setTimeout(() => {
          this._pending = null;
          reject(new Error(`ask timed out after ${this.askTimeout}ms`));
        }, this.askTimeout);

        this._pending = {
          resolve: (d) => {
            clearTimeout(timer);
            resolve(d);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        this._send({ action: "ask", query });
      });

    // Chain onto the queue so only one ask is outstanding at a time, and keep
    // the queue alive when one rejects.
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}
