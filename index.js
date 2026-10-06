'use strict';
// OSTO Shinra Meter: starts the damage meter in Toolbox mode when a game client connects.
//
// The meter reads packets from the Toolbox (through the external-interface mod) instead of
// capturing them off the network, so it needs no administrator rights, no WinPcap and no
// firewall exception. It has to be running BEFORE the game logs in to the server, because
// it learns the game version from the first packet of the connection. Starting it here,
// on the client interface becoming ready, guarantees that.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ShinraMeter {
    constructor(mod) {
        const meterPath = path.join(__dirname, 'ShinraMeter.exe');

        mod.clientInterface.once('ready', () => {
            if (!fs.existsSync(meterPath)) {
                mod.log('ShinraMeter.exe is missing from the mod folder. Reinstall the mod.');
                return;
            }
            mod.log('Starting Shinra Meter...');
            try {
                // The meter allows only one copy of itself: a second start exits at once.
                const meter = spawn(meterPath, ['--toolbox'], { cwd: __dirname, stdio: 'ignore', detached: true });
                meter.on('error', (e) => mod.log(`Could not start Shinra Meter: ${e.message}`));
                meter.on('exit', () => mod.log('Shinra Meter closed (or it was already running).'));
                meter.unref();
            } catch (e) {
                mod.log(`Could not start Shinra Meter: ${e.message}`);
            }
        });
    }
}

exports.ClientMod = ShinraMeter;
