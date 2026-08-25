// ==UserScript==
// @name         TwitchAd Blocker
// @namespace    rebelbandit.twitch
// @version      1.1.1
// @description  VAFT2 Twitch adblock + automatic frozen-video recovery + duplicate-audio cleanup + discreet toast + persistent diagnostics
// @author       scamorza + rebel_bandit
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @require      https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================

    const CFG = {
        // VAFT fallback order
        backupPlayerTypes: ['popout', 'autoplay'],

        // Freeze detection
        freezeThresholdMs: 750,
        checkEveryMs: 150,

        // Quality bounce timing
        bounceHoldMs: 350,

        // How long we wait for actual frames after recovery
        verifyMs: 1000,

        // Avoid recovery spam
        cooldownMs: 2500,

        // Source-only / no-transcode fallback
        pausePlayFallback: true,

        // Keep OFF: Twitch reload can trigger another preroll
        reloadOnFailure: false,

        // Duplicate audio cleanup after ad ends
        audioCleanup: true,
        audioCleanupDelayMs: 300,

        // Toast
        toast: true,
        toastTop: 70,
        toastRight: 18,

        // Persistent diagnostic history
        persistentLog: true,
        maxLogEntries: 50,

        // Console debugging
        debug: true
    };


    // ============================================================
    // LOGGING
    // ============================================================

    function log(...args) {
        if (CFG.debug) {
            console.log('[RB-VAFT]', ...args);
        }
    }


    // ============================================================
    // PERSISTENT EVENT LOG
    // ============================================================

    const LOG_KEY = 'rb-vaft-event-log';


    function readEventLog() {
        try {
            const parsed = JSON.parse(
                localStorage.getItem(LOG_KEY) || '[]'
            );

            return Array.isArray(parsed)
                ? parsed
                : [];

        } catch {
            return [];
        }
    }


    function writeEventLog(entries) {
        if (!CFG.persistentLog) {
            return;
        }

        try {
            localStorage.setItem(
                LOG_KEY,
                JSON.stringify(
                    entries.slice(-CFG.maxLogEntries)
                )
            );
        } catch {}
    }


    function eventLog(message, extra = null) {
        const entries = readEventLog();

        entries.push({
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            message,
            extra
        });

        writeEventLog(entries);

        log(
            message,
            extra !== null ? extra : ''
        );
    }


    // ============================================================
    // APPLY VAFT SETTINGS
    // ============================================================

    let vaftConfigured = false;


    function configureVAFT() {
        if (!window.vaft2?.config) {
            return false;
        }

        const c = window.vaft2.config;

        c.BackupPlayerTypes =
            CFG.backupPlayerTypes.slice();

        // Our toast replaces original VAFT banner
        c.ShowBanner = false;

        c.BlockAds = true;
        c.StripAdSegments = true;
        c.RenumberSequence = true;

        // Avoid reload/preroll loops
        c.ReloadPlayerAfterAd = false;

        if (!vaftConfigured) {
            vaftConfigured = true;

            log(
                'VAFT configured:',
                CFG.backupPlayerTypes
            );
        }

        return true;
    }


    configureVAFT();


    let vaftConfigAttempts = 0;

    const vaftConfigTimer = setInterval(() => {
        vaftConfigAttempts++;

        if (
            configureVAFT() ||
            vaftConfigAttempts >= 100
        ) {
            clearInterval(vaftConfigTimer);
        }

    }, 20);


    // ============================================================
    // STATE
    // ============================================================

    const State = {
        video: null,

        lastFrames: null,
        lastProgressAt: performance.now(),

        recovering: false,
        lastRecoveryAt: 0,

        adWasActive: false,
        lastBackupType: null,

        toastTimer: null,
        audioCleanupTimer: null,

        counters: {
            adBreaks: 0,
            freezes: 0,
            qualityBounces: 0,
            pausePlays: 0,
            recovered: 0,
            failed: 0,
            duplicateAudioCleanups: 0,
            duplicatePlayersStopped: 0
        }
    };


    // ============================================================
    // TOAST
    // ============================================================

    function toast(message, duration = 0) {
        if (!CFG.toast || !document.body) {
            return;
        }

        let el =
            document.getElementById('rb-vaft-toast');

        if (!el) {
            el = document.createElement('div');
            el.id = 'rb-vaft-toast';

            Object.assign(el.style, {
                position: 'fixed',

                top: CFG.toastTop + 'px',
                right: CFG.toastRight + 'px',

                zIndex: '2147483647',

                padding: '6px 10px',
                borderRadius: '7px',

                background: 'rgba(0,0,0,.72)',
                color: 'rgba(255,255,255,.94)',

                fontSize: '12px',
                lineHeight: '16px',

                fontFamily:
                    'Inter, Arial, sans-serif',

                fontWeight: '600',

                pointerEvents: 'none',
                userSelect: 'none',

                backdropFilter: 'blur(5px)',
                WebkitBackdropFilter: 'blur(5px)',

                boxShadow:
                    '0 2px 10px rgba(0,0,0,.22)',

                opacity: '0',

                transform:
                    'translateY(-2px)',

                transition:
                    'opacity .16s ease, transform .16s ease'
            });

            document.body.appendChild(el);
        }

        clearTimeout(State.toastTimer);

        el.textContent = message;

        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';

        if (duration > 0) {
            State.toastTimer = setTimeout(() => {
                el.style.opacity = '0';
                el.style.transform =
                    'translateY(-2px)';
            }, duration);
        }
    }


    function hideToast() {
        clearTimeout(State.toastTimer);

        const el =
            document.getElementById(
                'rb-vaft-toast'
            );

        if (el) {
            el.style.opacity = '0';
            el.style.transform =
                'translateY(-2px)';
        }
    }


    // ============================================================
    // TWITCH PLAYER DISCOVERY
    // ============================================================

    function findReactNode(root, predicate) {
        if (!root) {
            return null;
        }

        try {
            if (
                root.stateNode &&
                predicate(root.stateNode)
            ) {
                return root.stateNode;
            }
        } catch {}

        let node = root.child;

        while (node) {
            const found =
                findReactNode(node, predicate);

            if (found) {
                return found;
            }

            node = node.sibling;
        }

        return null;
    }


    let playerCache = null;


    function playerCacheValid() {
        try {
            if (!playerCache) {
                return false;
            }

            const video =
                playerCache
                    .getHTMLVideoElement?.();

            return !!video &&
                video.isConnected;

        } catch {
            return false;
        }
    }


    function getPlayer() {
        if (playerCacheValid()) {
            return playerCache;
        }

        const rootNode =
            document.querySelector('#root');

        if (!rootNode) {
            return null;
        }

        let reactRoot = null;

        try {
            if (
                rootNode
                    ._reactRootContainer
                    ?._internalRoot
                    ?.current
            ) {
                reactRoot =
                    rootNode
                        ._reactRootContainer
                        ._internalRoot
                        .current;

            } else {
                const key =
                    Object.keys(rootNode)
                        .find(x =>
                            x.startsWith(
                                '__reactContainer'
                            )
                        );

                reactRoot =
                    key
                        ? rootNode[key]
                        : null;
            }

        } catch {}

        if (!reactRoot) {
            return null;
        }

        let instance =
            findReactNode(
                reactRoot,
                n =>
                    n.setPlayerActive &&
                    n.props
                        ?.mediaPlayerInstance
            );

        instance =
            instance
                ?.props
                ?.mediaPlayerInstance
                || null;

        if (instance?.playerInstance) {
            instance =
                instance.playerInstance;
        }

        if (
            instance &&
            typeof instance.getQuality ===
                'function' &&
            typeof instance.getQualities ===
                'function' &&
            typeof instance.setQuality ===
                'function'
        ) {
            playerCache = instance;
            return instance;
        }

        return null;
    }


    // ============================================================
    // VIDEO ELEMENT
    // ============================================================

    function getVideo() {
        try {
            const player =
                getPlayer();

            const video =
                player
                    ?.getHTMLVideoElement
                    ?.();

            if (video) {
                return video;
            }

        } catch {}

        const videos =
            [...document.querySelectorAll(
                'video'
            )];

        if (!videos.length) {
            return null;
        }

        return videos
            .filter(v =>
                v.readyState > 0
            )
            .sort((a, b) =>
                (
                    b.clientWidth *
                    b.clientHeight
                ) -
                (
                    a.clientWidth *
                    a.clientHeight
                )
            )[0] || videos[0];
    }


    // ============================================================
    // DUPLICATE AUDIO CLEANUP - v1.1.1
    // ============================================================

    function getVideoAudioStatus() {
        const activeVideo =
            getVideo();

        const videos =
            [...document.querySelectorAll(
                'video'
            )];

        return videos.map(
            (video, index) => ({
                index,

                active:
                    video === activeVideo,

                connected:
                    video.isConnected,

                paused:
                    video.paused,

                ended:
                    video.ended,

                muted:
                    video.muted,

                volume:
                    video.volume,

                readyState:
                    video.readyState,

                currentTime:
                    Number.isFinite(
                        video.currentTime
                    )
                        ? Math.round(
                            video.currentTime *
                            10
                        ) / 10
                        : null,

                resolution:
                    `${video.videoWidth}x${video.videoHeight}`,

                width:
                    video.clientWidth,

                height:
                    video.clientHeight
            })
        );
    }


    function cleanupDuplicateAudio() {
        try {
            const activeVideo =
                getVideo();

            const videos =
                [...document.querySelectorAll(
                    'video'
                )];

            if (!videos.length) {
                return 0;
            }

            if (!activeVideo) {
                eventLog(
                    'AUDIO CLEANUP SKIPPED',
                    'active video not found'
                );

                return 0;
            }

            let cleaned = 0;

            for (const video of videos) {
                if (
                    video === activeVideo
                ) {
                    continue;
                }

                /*
                 * Only touch secondary media elements
                 * that could actually still produce
                 * duplicate stream audio.
                 */
                if (
                    !video.paused &&
                    !video.ended &&
                    video.readyState > 0
                ) {
                    try {
                        video.muted = true;
                        video.volume = 0;
                        video.pause();

                        cleaned++;

                    } catch {}
                }
            }

            if (cleaned > 0) {
                State.counters
                    .duplicateAudioCleanups++;

                State.counters
                    .duplicatePlayersStopped +=
                    cleaned;

                eventLog(
                    'DUPLICATE AUDIO CLEANUP',
                    {
                        extraPlayersStopped:
                            cleaned,

                        totalVideoElements:
                            videos.length
                    }
                );

                log(
                    'Duplicate audio cleanup:',
                    cleaned,
                    'extra video player(s) stopped'
                );
            }

            return cleaned;

        } catch (err) {
            eventLog(
                'AUDIO CLEANUP ERROR',
                String(err)
            );

            return 0;
        }
    }


    function scheduleAudioCleanup() {
        if (!CFG.audioCleanup) {
            return;
        }

        clearTimeout(
            State.audioCleanupTimer
        );

        State.audioCleanupTimer =
            setTimeout(() => {
                cleanupDuplicateAudio();
            }, CFG.audioCleanupDelayMs);
    }


    // ============================================================
    // VAFT STATE
    // ============================================================

    function vaftStatus() {
        try {
            return window
                .vaft2
                ?.status
                ?.() || null;

        } catch {
            return null;
        }
    }


    // ============================================================
    // HELPERS
    // ============================================================

    function sleep(ms) {
        return new Promise(
            resolve =>
                setTimeout(resolve, ms)
        );
    }


    function qualityPixels(q) {
        if (
            typeof q?.width === 'number' &&
            typeof q?.height === 'number'
        ) {
            return q.width * q.height;
        }

        const name =
            q?.name ||
            q?.group ||
            '';

        const m =
            String(name)
                .match(/(\d{3,4})p/i);

        if (!m) {
            return 0;
        }

        const h =
            Number(m[1]);

        return h * h;
    }


    function qualityName(q) {
        return (
            q?.name ||
            q?.group ||
            'unknown'
        );
    }


    // ============================================================
    // FRAME DETECTION
    // ============================================================

    function decodedFrames(video) {
        if (!video) {
            return null;
        }

        if (
            typeof video
                .webkitDecodedFrameCount ===
            'number'
        ) {
            return video
                .webkitDecodedFrameCount;
        }

        return null;
    }


    async function waitForNewFrames(
        video,
        before,
        timeout
    ) {
        const started =
            performance.now();

        while (
            performance.now() - started <
            timeout
        ) {
            await sleep(100);

            const current =
                decodedFrames(video);

            if (
                current !== null &&
                before !== null
            ) {
                if (current > before) {
                    return true;
                }

                continue;
            }

            /*
             * Fallback if browser doesn't expose
             * decoded-frame counter.
             */

            if (
                !video.paused &&
                !video.ended &&
                video.readyState >= 2
            ) {
                return true;
            }
        }

        return false;
    }


    // ============================================================
    // QUALITY BOUNCE
    // ============================================================

    async function qualityBounce(video) {
        const player =
            getPlayer();

        if (!player) {
            eventLog(
                'QUALITY BOUNCE UNAVAILABLE',
                'player not found'
            );

            return false;
        }

        let current;
        let qualities;
        let wasAuto = false;

        try {
            current =
                player.getQuality();

            qualities =
                player.getQualities()
                || [];

            wasAuto =
                !!player
                    .isAutoQualityMode
                    ?.();

        } catch (err) {
            eventLog(
                'QUALITY BOUNCE UNAVAILABLE',
                String(err)
            );

            return false;
        }

        if (!current) {
            return false;
        }

        const currentName =
            qualityName(current);

        /*
         * Streamers may have Source only.
         * Never assume 720p exists.
         */

        let alternatives =
            qualities.filter(q => {
                if (!q) {
                    return false;
                }

                const name =
                    qualityName(q);

                if (
                    name === currentName
                ) {
                    return false;
                }

                if (/audio/i.test(name)) {
                    return false;
                }

                return true;
            });


        if (!alternatives.length) {
            eventLog(
                'NO ALTERNATE TRANSCODE',
                currentName
            );

            return false;
        }


        const currentPixels =
            qualityPixels(current);


        /*
         * Prefer closest LOWER quality.
         */

        const below =
            alternatives
                .filter(q =>
                    qualityPixels(q) <
                    currentPixels
                )
                .sort(
                    (a, b) =>
                        qualityPixels(b) -
                        qualityPixels(a)
                );


        let target;


        if (below.length) {
            target = below[0];

        } else {
            /*
             * No lower option.
             * Use closest alternative.
             */

            alternatives.sort(
                (a, b) =>
                    Math.abs(
                        qualityPixels(a) -
                        currentPixels
                    ) -
                    Math.abs(
                        qualityPixels(b) -
                        currentPixels
                    )
            );

            target =
                alternatives[0];
        }


        if (!target) {
            return false;
        }


        const targetName =
            qualityName(target);


        State.counters
            .qualityBounces++;


        toast(
            `AD • recovering ${currentName} → ${targetName}`
        );


        eventLog(
            'QUALITY BOUNCE',
            `${currentName} → ${targetName} → ${currentName}`
        );


        const before =
            decodedFrames(video);


        try {
            player.setQuality(target);

        } catch (err) {
            eventLog(
                'QUALITY BOUNCE FAILED',
                String(err)
            );

            return false;
        }


        await sleep(
            CFG.bounceHoldMs
        );


        /*
         * Twitch may rebuild the ladder after
         * setQuality(), so re-read it.
         */

        try {
            const newLadder =
                player.getQualities()
                || [];

            const original =
                newLadder.find(q =>
                    qualityName(q) ===
                    currentName
                );

            if (original) {
                player.setQuality(
                    original
                );

            } else {
                eventLog(
                    'ORIGINAL QUALITY MISSING',
                    currentName
                );
            }

        } catch (err) {
            eventLog(
                'QUALITY RESTORE ERROR',
                String(err)
            );
        }


        /*
         * Restore Auto if viewer was using Auto.
         */

        if (
            wasAuto &&
            typeof player
                .setAutoQualityMode ===
            'function'
        ) {
            setTimeout(() => {
                try {
                    player
                        .setAutoQualityMode(
                            true
                        );
                } catch {}
            }, 250);
        }


        /*
         * Actual recovery requires NEW frames.
         */

        const resumed =
            await waitForNewFrames(
                video,
                before,
                CFG.verifyMs
            );


        if (resumed) {
            eventLog(
                'FRAMES RESUMED',
                'quality bounce'
            );

        } else {
            eventLog(
                'BOUNCE FAILED',
                'video still frozen'
            );
        }


        return resumed;
    }


    // ============================================================
    // PAUSE / PLAY FALLBACK
    // ============================================================

    async function pausePlay(video) {
        if (!video) {
            return false;
        }


        State.counters
            .pausePlays++;


        toast(
            'AD • restarting video'
        );


        eventLog(
            'PAUSE/PLAY RECOVERY'
        );


        const before =
            decodedFrames(video);


        const player =
            getPlayer();


        try {
            if (
                player &&
                typeof player.pause ===
                    'function'
            ) {
                player.pause();

                await sleep(180);

                const result =
                    player.play();

                if (result?.catch) {
                    result.catch(
                        () => {}
                    );
                }

            } else {
                video.pause();

                await sleep(180);

                await video.play();
            }

        } catch (err) {
            eventLog(
                'PAUSE/PLAY FAILED',
                String(err)
            );

            return false;
        }


        const resumed =
            await waitForNewFrames(
                video,
                before,
                CFG.verifyMs
            );


        if (resumed) {
            eventLog(
                'FRAMES RESUMED',
                'pause/play'
            );
        }


        return resumed;
    }


    // ============================================================
    // RECOVERY PIPELINE
    // ============================================================

    async function recover(video) {
        if (State.recovering) {
            return;
        }


        const now =
            performance.now();


        if (
            now -
            State.lastRecoveryAt <
            CFG.cooldownMs
        ) {
            return;
        }


        State.recovering = true;
        State.lastRecoveryAt = now;

        State.counters.freezes++;


        const frozenFor =
            Math.round(
                now -
                State.lastProgressAt
            );


        toast(
            'AD • video freeze detected'
        );


        eventLog(
            'FREEZE DETECTED',
            {
                frozenForMs: frozenFor
            }
        );


        let success = false;


        // --------------------------------------------------------
        // Recovery #1
        // Quality bounce
        // --------------------------------------------------------

        success =
            await qualityBounce(
                video
            );


        // --------------------------------------------------------
        // Recovery #2
        // pause/play
        // --------------------------------------------------------

        if (
            !success &&
            CFG.pausePlayFallback
        ) {
            success =
                await pausePlay(
                    video
                );
        }


        // --------------------------------------------------------
        // Recovery #3
        // intentionally disabled
        // --------------------------------------------------------

        if (
            !success &&
            CFG.reloadOnFailure
        ) {
            try {
                const player =
                    getPlayer();

                player?.pause?.();

                await sleep(150);

                player?.play?.();

            } catch {}
        }


        if (success) {
            State.counters
                .recovered++;


            toast(
                'AD • recovered ✓',
                1400
            );


            eventLog(
                'RECOVERY SUCCESS'
            );

        } else {
            State.counters
                .failed++;


            toast(
                'AD • recovery failed',
                2000
            );


            eventLog(
                'RECOVERY FAILED'
            );
        }


        State.video =
            getVideo();

        State.lastFrames =
            decodedFrames(
                State.video
            );

        State.lastProgressAt =
            performance.now();

        State.recovering =
            false;
    }


    // ============================================================
    // AD LABEL
    // ============================================================

    function adLabel(status) {
        if (
            status.strippingSegments
        ) {
            return 'AD • stripping';
        }


        switch (
            status.backupPlayerType
        ) {
            case 'popout':
                return 'AD • popout';

            case 'autoplay':
                return 'AD • fallback 360p';

            case 'mobile_feed':
                return 'AD • mobile';

            default:
                return 'AD • detecting';
        }
    }


    // ============================================================
    // MAIN WATCHER
    // ============================================================

    function tick() {
        const status =
            vaftStatus();


        if (!status) {
            return;
        }


        const adActive =
            status.adActive === true;


        // --------------------------------------------------------
        // AD START
        // --------------------------------------------------------

        if (
            adActive &&
            !State.adWasActive
        ) {
            State.adWasActive = true;

            State.counters.adBreaks++;


            /*
             * Cancel any pending cleanup from a previous ad
             * if another ad state starts immediately.
             */

            clearTimeout(
                State.audioCleanupTimer
            );


            State.video =
                getVideo();

            State.lastFrames =
                decodedFrames(
                    State.video
                );

            State.lastProgressAt =
                performance.now();


            const label =
                adLabel(status);


            toast(label);


            eventLog(
                'AD START',
                label
            );
        }


        // --------------------------------------------------------
        // AD END
        // --------------------------------------------------------

        if (
            !adActive &&
            State.adWasActive
        ) {
            State.adWasActive =
                false;

            State.lastBackupType =
                null;

            State.video = null;
            State.lastFrames = null;

            State.lastProgressAt =
                performance.now();


            /*
             * v1.1.1:
             *
             * VAFT/Twitch can occasionally leave a stale
             * video element alive after returning from the
             * backup stream.
             *
             * That can cause the normal stream + stale
             * stream audio to play simultaneously.
             *
             * Give Twitch a moment to settle, then stop
             * audio from secondary video elements.
             */

            scheduleAudioCleanup();


            toast(
                'Ad skipped ✓',
                1600
            );


            eventLog(
                'AD END',
                {
                    totalAdBreaks:
                        State.counters.adBreaks,

                    freezes:
                        State.counters.freezes,

                    recovered:
                        State.counters.recovered,

                    failed:
                        State.counters.failed,

                    audioCleanups:
                        State.counters
                            .duplicateAudioCleanups
                }
            );


            return;
        }


        if (!adActive) {
            State.video = null;
            State.lastFrames = null;

            return;
        }


        // --------------------------------------------------------
        // BACKUP TYPE CHANGED
        // --------------------------------------------------------

        const backupKey =
            (
                status
                    .backupPlayerType
                    || ''
            ) +
            ':' +
            (
                status
                    .strippingSegments
                    ? 'strip'
                    : ''
            );


        if (
            backupKey !==
            State.lastBackupType
        ) {
            State.lastBackupType =
                backupKey;


            const label =
                adLabel(status);


            if (!State.recovering) {
                toast(label);
            }


            eventLog(
                'BACKUP',
                label
            );


            /*
             * Playlist changed.
             * Reset frame baseline.
             */

            State.video =
                getVideo();

            State.lastFrames =
                decodedFrames(
                    State.video
                );

            State.lastProgressAt =
                performance.now();
        }


        // --------------------------------------------------------
        // VIDEO
        // --------------------------------------------------------

        const video =
            getVideo();


        if (!video) {
            return;
        }


        if (
            video !==
            State.video
        ) {
            State.video = video;

            State.lastFrames =
                decodedFrames(video);

            State.lastProgressAt =
                performance.now();

            return;
        }


        // --------------------------------------------------------
        // FRAME PROGRESS
        // --------------------------------------------------------

        const now =
            performance.now();

        const frames =
            decodedFrames(video);


        /*
         * Chromium / Opera:
         *
         * We deliberately DO NOT use currentTime.
         *
         * Audio can continue, currentTime can advance,
         * while the displayed AVC video is frozen.
         */

        if (frames !== null) {
            if (
                State.lastFrames === null
            ) {
                State.lastFrames =
                    frames;

                State.lastProgressAt =
                    now;

                return;
            }


            if (
                frames >
                State.lastFrames
            ) {
                State.lastFrames =
                    frames;

                State.lastProgressAt =
                    now;

                return;
            }

        } else {
            /*
             * Better fallback for browsers without
             * webkitDecodedFrameCount.
             */

            if (
                typeof video
                    .requestVideoFrameCallback ===
                'function'
            ) {
                if (
                    !video
                        .__rbFrameWatchPending
                ) {
                    video
                        .__rbFrameWatchPending =
                        true;

                    video
                        .requestVideoFrameCallback(
                            () => {
                                video
                                    .__rbFrameWatchPending =
                                    false;

                                State
                                    .lastProgressAt =
                                    performance.now();
                            }
                        );
                }

            } else {
                /*
                 * Last-resort fallback.
                 */

                if (
                    !video.paused &&
                    video.readyState >= 3
                ) {
                    State.lastProgressAt =
                        now;
                }
            }
        }


        // --------------------------------------------------------
        // FREEZE DETECTED?
        // --------------------------------------------------------

        if (
            !State.recovering &&
            now -
            State.lastProgressAt >=
            CFG.freezeThresholdMs
        ) {
            recover(video);
        }
    }


    // ============================================================
    // START
    // ============================================================

    function start() {
        if (
            window.self !==
            window.top
        ) {
            return;
        }


        setInterval(
            tick,
            CFG.checkEveryMs
        );


        log(
            'Seamless recovery active'
        );
    }


    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            start,
            {
                once: true
            }
        );

    } else {
        start();
    }


    // ============================================================
    // PUBLIC DEBUG API
    // ============================================================

    window.rbVAFT = {
        config: CFG,


        status() {
            const v =
                getVideo();

            const vaft =
                vaftStatus();

            const result = {
                version: '1.1.1',

                vaftVersion:
                    vaft?.version || null,

                adActive:
                    !!vaft?.adActive,

                backupPlayerType:
                    vaft
                        ?.backupPlayerType
                        || null,

                strippingSegments:
                    !!vaft
                        ?.strippingSegments,

                recovering:
                    State.recovering,

                decodedFrames:
                    decodedFrames(v),

                frozenForMs:
                    Math.round(
                        performance.now() -
                        State.lastProgressAt
                    ),

                videoElements:
                    document
                        .querySelectorAll(
                            'video'
                        ).length,

                counters: {
                    ...State.counters
                }
            };


            console.table({
                version:
                    result.version,

                vaftVersion:
                    result.vaftVersion,

                adActive:
                    result.adActive,

                backup:
                    result.backupPlayerType,

                stripping:
                    result.strippingSegments,

                recovering:
                    result.recovering,

                decodedFrames:
                    result.decodedFrames,

                frozenForMs:
                    result.frozenForMs,

                videoElements:
                    result.videoElements,

                adBreaks:
                    result
                        .counters
                        .adBreaks,

                freezes:
                    result
                        .counters
                        .freezes,

                recovered:
                    result
                        .counters
                        .recovered,

                failed:
                    result
                        .counters
                        .failed,

                audioCleanups:
                    result
                        .counters
                        .duplicateAudioCleanups,

                extraPlayersStopped:
                    result
                        .counters
                        .duplicatePlayersStopped
            });


            return result;
        },


        audioStatus() {
            const result =
                getVideoAudioStatus();

            console.table(result);

            return result;
        },


        cleanupAudio() {
            const before =
                getVideoAudioStatus();

            console.log(
                '[RB-VAFT] audio status BEFORE cleanup'
            );

            console.table(before);


            const cleaned =
                cleanupDuplicateAudio();


            const after =
                getVideoAudioStatus();

            console.log(
                '[RB-VAFT] audio status AFTER cleanup'
            );

            console.table(after);


            return {
                cleaned,
                before,
                after
            };
        },


        log() {
            const entries =
                readEventLog();


            console.table(
                entries.map(e => ({
                    time:
                        e.time,

                    event:
                        e.message,

                    details:
                        typeof e.extra ===
                        'object'

                            ? JSON.stringify(
                                e.extra
                            )

                            : (
                                e.extra ||
                                ''
                            )
                }))
            );


            return entries;
        },


        stats() {
            const entries =
                readEventLog();


            const count =
                name =>
                    entries.filter(
                        e =>
                            e.message ===
                            name
                    ).length;


            const result = {
                adStarts:
                    count('AD START'),

                adEnds:
                    count('AD END'),

                freezes:
                    count(
                        'FREEZE DETECTED'
                    ),

                qualityBounces:
                    count(
                        'QUALITY BOUNCE'
                    ),

                framesResumed:
                    count(
                        'FRAMES RESUMED'
                    ),

                pausePlayRecoveries:
                    count(
                        'PAUSE/PLAY RECOVERY'
                    ),

                recoverySuccesses:
                    count(
                        'RECOVERY SUCCESS'
                    ),

                recoveryFailures:
                    count(
                        'RECOVERY FAILED'
                    ),

                duplicateAudioCleanups:
                    count(
                        'DUPLICATE AUDIO CLEANUP'
                    ),

                audioCleanupErrors:
                    count(
                        'AUDIO CLEANUP ERROR'
                    ),

                storedEvents:
                    entries.length
            };


            console.table(result);

            return result;
        },


        clearLog() {
            try {
                localStorage.removeItem(
                    LOG_KEY
                );
            } catch {}


            console.log(
                '[RB-VAFT] event log cleared'
            );

            return true;
        },


        recover() {
            const video =
                getVideo();


            if (!video) {
                console.warn(
                    '[RB-VAFT] no video found'
                );

                return false;
            }


            recover(video);

            return true;
        },


        hideToast() {
            hideToast();
        }
    };


    console.log(
        '[RB-VAFT] loaded — v1.1.1'
    );

})();
