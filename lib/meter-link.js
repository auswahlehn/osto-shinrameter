'use strict';
// The link between the Toolbox and the damage meter.
//
// The meter asks questions and sets up hooks over a small JSON-RPC endpoint (control), and
// receives the game packets it hooked over a plain TCP stream (data). This replaces the
// separate "external-interface" mod, which kept its hook list in one shared table: after a
// second game client was opened and closed, the meter's hooks were installed again on the
// remaining client, every packet arrived twice, and the meter counted double damage (three
// times after two extra clients, and so on).
//
// Rules here:
//   - hooks belong to ONE game connection and are tracked per connection, so they can never
//     be installed twice on the same connection;
//   - the meter follows one connection at a time (the oldest one still open); packets from
//     other clients are not sent, so a second character never mixes into the numbers;
//   - nothing in here may throw into the Toolbox: a busy port or a dropped socket is logged.
const net = require('net');
const http = require('http');
const fs = require('fs');

const DATA_ADDRESS = '127.0.0.60';
const DATA_PORT = 5311;
const CONTROL_ADDRESS = '127.0.0.61';
const CONTROL_PORT = 5310;
// Hooked on every connection from its first packet, so the meter can learn the game version.
const HANDSHAKE = ['C_CHECK_VERSION', 'C_LOGIN_ARBITER'];
// Run before every other mod, and keep the Toolbox's default filter: only REAL packets, never
// ones a mod made up (skill prediction fakes) or silenced.
const HOOK_OPTIONS = { order: -Infinity };

/** One game connection (the Toolbox makes one NetworkMod per connected client). */
class Link {
    constructor(mod) {
        this.mod = mod;
        this.hooks = new Map();     // opcode name -> hook handle
        this.cache = [];            // packets seen before character select, replayed to a meter that connects late
        this.caching = true;
        this.closed = false;
        for (const name of HANDSHAKE) this.addHook(name);
        try {
            // Once a character is picked the meter must already be listening; stop holding packets.
            this.selectHook = mod.hook('C_SELECT_USER', 'raw', () => { this.caching = false; this.cache = []; });
        } catch (_) { /* unknown opcode on this patch: keep caching the (few) early packets */ }
        State.links.push(this);
    }

    addHook(name) {
        if (this.closed || this.hooks.has(name)) return;
        try {
            const handle = this.mod.hook(name, 'raw', HOOK_OPTIONS, (code, data) => { this.forward(data); });
            this.hooks.set(name, handle);
        } catch (_) { /* the meter asks for every opcode it knows; many do not exist on patch 31 */ }
    }

    removeHook(name) {
        const handle = this.hooks.get(name);
        if (!handle) return;
        try { this.mod.unhook(handle); } catch (_) { /* connection already gone */ }
        this.hooks.delete(name);
    }

    forward(data) {
        const packet = Buffer.from(data);
        if (this.caching) this.cache.push(packet);
        if (State.active() !== this) return;
        for (const socket of State.sockets) {
            try { socket.write(packet); } catch (_) { /* its error handler removes it */ }
        }
    }

    destructor() {
        if (this.closed) return;
        this.closed = true;
        const wasActive = State.active() === this;
        for (const name of Array.from(this.hooks.keys())) this.removeHook(name);
        if (this.selectHook) { try { this.mod.unhook(this.selectHook); } catch (_) {} }
        State.links = State.links.filter((l) => l !== this);
        this.cache = [];
        // The meter was following this client: end its stream so it resets and picks up the
        // next client (if any) from a clean start instead of mixing two sessions.
        if (wasActive) State.dropSockets();
        if (State.links.length === 0) State.stopDataServer();
    }
}

/** Shared between all connections of this Toolbox process. */
const State = {
    links: [],
    sockets: [],
    dataServer: null,
    log: () => {},

    /** The connection the meter follows: the oldest one still open. */
    active() { return this.links.length ? this.links[0] : null; },

    startDataServer() {
        if (this.dataServer) return;
        const server = net.createServer((socket) => {
            socket.setNoDelay(true);
            this.sockets.push(socket);
            const drop = () => { this.sockets = this.sockets.filter((s) => s !== socket); try { socket.destroy(); } catch (_) {} };
            socket.on('error', drop);
            socket.on('close', drop);
            socket.on('end', drop);
            const link = this.active();
            if (link && link.caching) {
                for (const packet of link.cache) { try { socket.write(packet); } catch (_) {} }
            }
        });
        server.on('error', (e) => {
            this.log(`Meter data link could not start (${e.code || e.message}). Is another Toolbox already running?`);
            if (this.dataServer === server) this.dataServer = null;
        });
        server.listen(DATA_PORT, DATA_ADDRESS);
        this.dataServer = server;
    },

    dropSockets() {
        const sockets = this.sockets;
        this.sockets = [];
        for (const socket of sockets) { try { socket.destroy(); } catch (_) {} }
    },

    stopDataServer() {
        this.dropSockets();
        if (this.dataServer) { try { this.dataServer.close(); } catch (_) {} this.dataServer = null; }
    }
};

/** What the meter may ask. Each answer comes from the connection the meter follows. */
const Rpc = {
    getToolboxPID() { return process.pid; },

    getServerInfo() {
        const link = State.active();
        if (!link) return null;
        const list = link.mod.serverList || {};
        return list[link.mod.serverId] || null;
    },
    getServerId() {
        const link = State.active();
        if (!link) return 0;
        const info = Rpc.getServerInfo();
        return Number((info && info.id) || link.mod.serverId || 0) || 0;
    },
    getServer() { return Rpc.getServerId(); },

    getProtocolVersion() {
        const link = State.active();
        return link ? Number(link.mod.dispatch.protocolVersion) || 0 : 0;
    },
    getReleaseVersion() {
        const link = State.active();
        if (!link) return 0;
        const version = Number(link.mod.majorPatchVersion) * 100 + Number(link.mod.minorPatchVersion);
        return Number.isFinite(version) ? version : 0;
    },
    getLanguage() {
        const link = State.active();
        if (!link) return '';
        switch (String(link.mod.language || '').toUpperCase()) {
            case 'EUR': case 'FRA': case 'GER': return 'EU';
            case 'RUS': return 'RU';
            case 'KOR': return 'KR';
            case 'JPN': return 'JP';
            case 'TW': return 'TW';
            default: return '';
        }
    },

    addHooks(params) {
        const link = State.active();
        if (!link || !params || !Array.isArray(params.hooks)) return false;
        for (const name of params.hooks) link.addHook(String(name));
        return true;
    },
    removeHooks(params) {
        const link = State.active();
        if (!link || !params || !Array.isArray(params.hooks)) return false;
        for (const name of params.hooks) {
            if (!HANDSHAKE.includes(String(name))) link.removeHook(String(name));
        }
        return true;
    },

    /** Writes the opcode (or system message) table as "NAME CODE" lines to a file the meter names. */
    dumpMapSync(params) {
        const link = State.active();
        if (!link || !params || !params.path) return false;
        const dispatch = link.mod.dispatch;
        const map = params.mapType === 'sysmsg' ? dispatch.sysmsgMap.name : dispatch.protocolMap.name;
        let content = '';
        for (const [name, code] of map) content += `${name} ${code}\n`;
        fs.writeFileSync(params.path, content);
        return true;
    },

    addDefinition(params) {
        const link = State.active();
        if (!link) return false;
        const def = String(params.def || '').split('\n').map((field) => field.split(' '));
        link.mod.dispatch.addDefinition(params.opcodeName, params.version, def);
        return true;
    },
    addOpcode(params) {
        const link = State.active();
        if (!link) return false;
        link.mod.dispatch.addOpcode(params.opcodeName, params.opcode);
        return true;
    }
};

/** The control endpoint. One per Toolbox process (GlobalMod). */
class Control {
    constructor(mod) {
        State.log = (message) => { try { mod.log(message); } catch (_) {} };
        this.server = http.createServer((req, res) => {
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); if (body.length > 1e6) req.destroy(); });
            req.on('error', () => {});
            req.on('end', () => {
                let id = null;
                let reply;
                try {
                    const request = JSON.parse(body);
                    id = request.id === undefined ? null : request.id;
                    const handler = Object.prototype.hasOwnProperty.call(Rpc, request.method) ? Rpc[request.method] : null;
                    if (!handler) throw new Error(`Unknown method "${request.method}"`);
                    const result = handler(request.params);
                    reply = { jsonrpc: '2.0', result: result === undefined ? null : result, id };
                } catch (e) {
                    reply = { jsonrpc: '2.0', error: { code: -1, message: String(e && e.message ? e.message : e) }, id };
                }
                const text = JSON.stringify(reply);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
                res.end(text);
            });
        });
        this.server.on('error', (e) => {
            State.log(`Meter control link could not start (${e.code || e.message}). Is another Toolbox already running?`);
        });
        this.server.listen(CONTROL_PORT, CONTROL_ADDRESS);
    }

    destructor() {
        try { this.server.close(); } catch (_) {}
        State.stopDataServer();
    }
}

/** One per game connection (NetworkMod). */
class Data extends Link {
    constructor(mod) {
        State.startDataServer();
        super(mod);
    }
}

module.exports = { Control, Data, State, Rpc, DATA_PORT, CONTROL_PORT };
