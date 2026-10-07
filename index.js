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

// ---- Linux (Wine) -------------------------------------------------------------------------
// On Linux the launcher runs the Toolbox, and so this mod, inside the game's Wine session.
// The meter is a .NET 8 WPF program and needs four things there that Windows has anyway.

function underWine() {
    return !!(process.env.WINEPREFIX || process.env.WINELOADER || process.env.WINEDLLOVERRIDES);
}

/** True when WINEDLLOVERRIDES switches mscoree off ("mscoree=" or "mscoree=d"). Wine needs
 *  its mscoree to map the meter's .NET library files, even though no Mono is involved. */
function mscoreeOff(value) {
    return String(value || '').split(';').some((entry) => {
        const eq = entry.indexOf('=');
        if (eq < 0) return false;
        const names = entry.slice(0, eq).split(',').map((n) => n.trim().toLowerCase());
        const mode = entry.slice(eq + 1).trim().toLowerCase();
        return names.includes('mscoree') && (mode === '' || mode === 'd' || mode === 'disabled');
    });
}

/** The Wine build's own folder (".../files"), as a Windows path on Wine's Z: drive. */
function wineRoots() {
    const roots = [];
    const add = (unixDir) => {
        if (!unixDir || !unixDir.startsWith('/')) return;
        const win = 'Z:' + unixDir.replace(/\//g, '\\');
        if (!roots.includes(win)) roots.push(win);
    };
    if (process.env.WINELOADER) add(path.posix.dirname(path.posix.dirname(process.env.WINELOADER)));
    for (const dir of String(process.env.LD_LIBRARY_PATH || '').split(':')) {
        if (/\/lib(64)?\/?$/.test(dir)) add(path.posix.dirname(dir.replace(/\/$/, '')));
    }
    return roots;
}

/** Copy every file matching `pattern` from `from` to `to` unless it is already there. */
function copyMissing(from, to, pattern) {
    let copied = 0;
    let names;
    try { names = fs.readdirSync(from); } catch (_) { return 0; }
    for (const name of names) {
        if (!pattern.test(name)) continue;
        const dest = path.join(to, name);
        try {
            if (fs.existsSync(dest)) continue;
            fs.copyFileSync(path.join(from, name), dest);
            copied++;
        } catch (_) { /* best effort: a missing font is not worth failing the start */ }
    }
    return copied;
}

/** What Proton's own start script does and a plain Wine prefix lacks. Only adds missing
 *  files, never replaces one. */
function prepareWine(mod) {
    const fontsDir = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\windows', 'Fonts');
    let fonts = 0;
    let libs = 0;
    for (const root of wineRoots()) {
        // Fonts: the meter's text engine reads font files from C:\windows\Fonts and stops the
        // program when it finds no Arial there.
        fonts += copyMissing(path.join(root, 'share', 'fonts'), fontsDir, /\.tt[fc]$/i);
        fonts += copyMissing(path.join(root, 'share', 'wine', 'fonts'), fontsDir, /\.tt[fc]$/i);
        // Wine's Direct3D needs these two helper libraries; next to the meter is enough.
        libs += copyMissing(path.join(root, 'lib64', 'vkd3d'), __dirname, /^libvkd3d.*\.dll$/i);
    }
    if (fonts || libs) mod.log(`Prepared Wine for the meter (${fonts} fonts, ${libs} libraries added).`);
}

// --------------------------------------------------------------------------------------------

class ShinraMeter {
    constructor(mod) {
        const meterPath = path.join(__dirname, 'ShinraMeter.exe');

        mod.clientInterface.once('ready', () => {
            if (!fs.existsSync(meterPath)) {
                mod.log('ShinraMeter.exe is missing from the mod folder. Reinstall the mod.');
                return;
            }
            const env = Object.assign({}, process.env);
            if (underWine()) {
                try { prepareWine(mod); } catch (e) { mod.log(`Could not prepare Wine for the meter: ${e.message}`); }
                // .NET would otherwise look for an ICU library that Wine does not provide.
                env.DOTNET_SYSTEM_GLOBALIZATION_USENLS = '1';
                // Wine reads its library switches from how the whole session was started, so
                // this cannot be fixed from here: the launcher has to start the Toolbox with
                // mscoree left on (launcher 2.0.4 and later do). Say so instead of failing silently.
                if (mscoreeOff(env.WINEDLLOVERRIDES)) {
                    mod.log('The meter cannot start under this launcher version on Linux (Wine\'s .NET loader is switched off). Update the launcher.');
                    return;
                }
            }
            mod.log('Starting Shinra Meter...');
            try {
                // The meter allows only one copy of itself: a second start exits at once.
                // Troubleshooting: set OSTO_METER_LOG to a file path to capture the meter's output.
                let stdio = 'ignore';
                if (process.env.OSTO_METER_LOG) {
                    try {
                        const fd = fs.openSync(process.env.OSTO_METER_LOG, 'a');
                        stdio = ['ignore', fd, fd];
                    } catch (_) { /* keep it silent */ }
                }
                const meter = spawn(meterPath, ['--toolbox'], { cwd: __dirname, stdio, detached: true, env });
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
